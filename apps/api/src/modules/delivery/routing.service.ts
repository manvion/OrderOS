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
 * Default is the public OSRM demo server — free and keyless so it works out of the
 * box — but it is a develop-and-small-scale default, not a plan for scale, exactly
 * like Nominatim is for geocoding. Set `OSRM_URL` to your own for production.
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

  private get baseUrl(): string {
    return this.config.get<string>('OSRM_URL') ?? 'https://router.project-osrm.org';
  }

  /**
   * The driving route between two points as `[lat, lng]` pairs following the roads,
   * or `null` when no route can be produced (the caller then draws a straight line).
   */
  async route(from: GeoPoint, to: GeoPoint): Promise<Array<[number, number]> | null> {
    const cacheKey = `route:${key(from)}->${key(to)}`;

    const cached = await this.redis.get<Array<[number, number]> | { miss: true }>(cacheKey);
    if (cached) return 'miss' in cached ? null : cached;

    try {
      // OSRM wants lng,lat — the opposite order to everything else here.
      const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
      const url = `${this.baseUrl}/route/v1/driving/${coords}?overview=full&geometries=geojson`;

      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`OSRM ${res.status}`);

      const body = (await res.json()) as {
        code: string;
        routes?: Array<{ geometry: { coordinates: Array<[number, number]> } }>;
      };
      const coordinates = body.routes?.[0]?.geometry.coordinates;

      if (body.code !== 'Ok' || !coordinates || coordinates.length < 2) {
        // A real "no drivable route" answer — cache it briefly so we don't hammer the
        // provider re-asking about a leg it just declined.
        await this.redis.set(cacheKey, { miss: true }, 60 * 60);
        return null;
      }

      // GeoJSON is [lng, lat]; the map wants [lat, lng].
      const latlngs = coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
      await this.redis.set(cacheKey, latlngs, RoutingService.CACHE_TTL_SECONDS);
      return latlngs;
    } catch (err) {
      // An outage must never break the map — the caller falls back to a straight line.
      // Not cached: a transient failure should be retried on the next poll.
      this.logger.warn(`Routing failed: ${(err as Error).message}`);
      return null;
    }
  }
}

// ~5 decimals ≈ 1m: fine enough that the cache key tracks real moves, coarse enough
// that GPS jitter doesn't blow the cache on every poll.
function key(p: GeoPoint): string {
  return `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
}
