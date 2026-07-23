import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/redis/redis.service';
import type { GeoPoint } from './geocoding.service';

/**
 * Driving directions: the road-following geometry from A to B.
 *
 * This runs SERVER-SIDE on purpose. The courier map used to call the public OSRM
 * server straight from the customer's browser, and that is exactly why the route so
 * often came back as a straight line "flying" over the streets: a free shared
 * routing server, hit once per customer per poll from thousands of different IPs,
 * rate-limits and times out, and the map's only fallback is the crow-flies line.
 *
 * Moving it here fixes that three ways:
 *  - ONE origin (our server) the provider sees, which we cache in Redis, so the same
 *    leg is one routing call no matter how many customers watch it.
 *  - The routing provider becomes a normal RUNTIME env (`OSRM_URL`), so a self-host
 *    can point at a reliable/self-hosted OSRM without rebuilding the web bundle.
 *  - A browser that can't reach the public OSRM (corporate wifi, ad blockers) still
 *    gets a real route, because it only ever talks to our own API.
 *
 * MULTI-COUNTRY: one OSRM instance only knows the region it was built from, so a
 * platform spanning countries runs one OSRM per region and maps each country to the
 * right one via `OSRM_URLS` — a JSON object keyed by country ISO code (several countries
 * can share a continent instance), e.g.
 *   OSRM_URLS={"CA":"http://osrm-na:5000","US":"http://osrm-na:5000","IN":"http://osrm-in:5000"}
 * The restaurant's country selects the instance. Falls back to the single `OSRM_URL`,
 * then the public demo server — so a country without its own OSRM still gets *a* route
 * (or, on any failure, the caller's straight line).
 */
@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);
  // Road geometry is traffic-agnostic and effectively static, so a long cache is safe.
  private static readonly CACHE_TTL_SECONDS = 24 * 60 * 60;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  /** Parsed once: a map of country ISO code -> OSRM base URL, from OSRM_URLS. */
  private urlsByCountryCache?: Record<string, string>;
  private get urlsByCountry(): Record<string, string> {
    if (this.urlsByCountryCache) return this.urlsByCountryCache;
    const raw = this.config.get<string>('OSRM_URLS');
    let parsed: Record<string, string> = {};
    if (raw) {
      try {
        const obj = JSON.parse(raw) as Record<string, string>;
        // Normalise keys to upper-case ISO so a "ca" mapping still matches "CA".
        parsed = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toUpperCase(), v]));
      } catch {
        this.logger.error('OSRM_URLS is not valid JSON — ignoring it, using OSRM_URL.');
      }
    }
    this.urlsByCountryCache = parsed;
    return parsed;
  }

  /** A configured OSRM instance for a country, or null when only the public demo applies. */
  private configuredOsrmFor(country?: string | null): string | null {
    const perCountry = country ? this.urlsByCountry[country.toUpperCase()] : undefined;
    return perCountry ?? this.config.get<string>('OSRM_URL') ?? null;
  }

  /**
   * The driving route between two points as `[lat, lng]` pairs following the roads,
   * or `null` when no route can be produced (the caller then draws a straight line).
   *
   * Provider order:
   *  1. A configured OSRM (per-country `OSRM_URLS`, or single `OSRM_URL`) — self-hosted,
   *     fast, free; use it wherever you run one.
   *  2. OpenRouteService (`ORS_API_KEY`) — a single free key that covers EVERY country,
   *     so a global platform gets real routes everywhere without an OSRM per region.
   *  3. The public OSRM demo — the keyless last resort (rate-limited; a straight line
   *     when it fails).
   */
  async route(
    from: GeoPoint,
    to: GeoPoint,
    opts: { country?: string | null } = {},
  ): Promise<Array<[number, number]> | null> {
    const osrm = this.configuredOsrmFor(opts.country);
    const orsKey = this.config.get<string>('ORS_API_KEY');
    const provider: 'osrm' | 'ors' = osrm ? 'osrm' : orsKey ? 'ors' : 'osrm';
    const osrmBase = osrm ?? 'https://router.project-osrm.org';

    // Cache per provider so a config change (or a fresh key) never serves a stale route.
    const providerId = provider === 'ors' ? 'ors' : hostOf(osrmBase);
    const cacheKey = `route:${providerId}:${key(from)}->${key(to)}`;

    const cached = await this.redis.get<Array<[number, number]> | { miss: true }>(cacheKey);
    if (cached) return 'miss' in cached ? null : cached;

    try {
      const latlngs =
        provider === 'ors'
          ? await this.fetchOrs(orsKey!, from, to)
          : await this.fetchOsrm(osrmBase, from, to);

      if (!latlngs) {
        // A real "no drivable route" answer — cache it briefly so we don't hammer the
        // provider re-asking about a leg it just declined.
        await this.redis.set(cacheKey, { miss: true }, 60 * 60);
        return null;
      }
      await this.redis.set(cacheKey, latlngs, RoutingService.CACHE_TTL_SECONDS);
      return latlngs;
    } catch (err) {
      // An outage must never break the map — the caller falls back to a straight line.
      this.logger.warn(`Routing (${provider}) failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** OSRM `/route` — returns [lat,lng] pairs, or null on a "no route" answer. */
  private async fetchOsrm(
    base: string,
    from: GeoPoint,
    to: GeoPoint,
  ): Promise<Array<[number, number]> | null> {
    // OSRM wants lng,lat — the opposite order to everything else here.
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`OSRM ${res.status}`);
    const body = (await res.json()) as {
      code: string;
      routes?: Array<{ geometry: { coordinates: Array<[number, number]> } }>;
    };
    const coordinates = body.routes?.[0]?.geometry.coordinates;
    if (body.code !== 'Ok' || !coordinates || coordinates.length < 2) return null;
    return coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
  }

  /** OpenRouteService `/directions` — global coverage from one free key. */
  private async fetchOrs(
    key: string,
    from: GeoPoint,
    to: GeoPoint,
  ): Promise<Array<[number, number]> | null> {
    const res = await fetch(
      'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
      {
        method: 'POST',
        headers: { Authorization: key, 'Content-Type': 'application/json' },
        // ORS wants lng,lat too.
        body: JSON.stringify({
          coordinates: [
            [from.longitude, from.latitude],
            [to.longitude, to.latitude],
          ],
        }),
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) throw new Error(`ORS ${res.status}`);
    const body = (await res.json()) as {
      features?: Array<{ geometry: { coordinates: Array<[number, number]> } }>;
    };
    const coordinates = body.features?.[0]?.geometry.coordinates;
    if (!coordinates || coordinates.length < 2) return null;
    return coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
  }
}

// ~5 decimals ≈ 1m: fine enough that the cache key tracks real moves, coarse enough
// that GPS jitter doesn't blow the cache on every poll.
function key(p: GeoPoint): string {
  return `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
}

/** Host of an OSRM base URL, for a short, stable cache-key segment. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'osrm';
  }
}
