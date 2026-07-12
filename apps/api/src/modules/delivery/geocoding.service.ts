import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../common/redis/redis.service';
import { withRetry } from '../../common/resilience/retry';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeocodableAddress {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * Address -> coordinates.
 *
 * This is what makes `deliveryRadiusMeters` real. Until now that setting was
 * decorative: it was stored, validated, shown in the UI, and enforced NOWHERE — a
 * restaurant could set a 2km radius and still be sent an order from 40km away,
 * because we had no coordinates to measure against.
 *
 * PROVIDER CHOICE, in order of preference:
 *
 *  1. Google — the best coverage, especially for India, where informal addresses
 *     ("opposite the temple, near Krishna Bakery") defeat most geocoders. Needs a key.
 *  2. Mapbox — good, cheaper, weaker on Indian addresses.
 *  3. Nominatim (OpenStreetMap) — free, no key, and therefore the default so the
 *     product WORKS out of the box. But its usage policy caps you at ~1 req/sec and
 *     forbids heavy commercial use, so it is a development and small-scale option,
 *     not a plan for a thousand restaurants. We log a warning saying exactly that.
 *
 * Results are cached in Redis forever-ish: a street address's coordinates do not
 * change, and the same customer ordering weekly should cost us one lookup, not
 * fifty.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private static readonly CACHE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    if (!this.googleKey && !this.mapboxKey && this.config.get('NODE_ENV') === 'production') {
      this.logger.warn(
        'No GOOGLE_MAPS_API_KEY or MAPBOX_TOKEN set. Falling back to Nominatim (OpenStreetMap), ' +
          'whose usage policy caps you at ~1 request/second and prohibits heavy commercial use. ' +
          'This will NOT scale past a handful of restaurants — set a real geocoder key.',
      );
    }
  }

  private get googleKey(): string | undefined {
    return this.config.get<string>('GOOGLE_MAPS_API_KEY');
  }

  private get mapboxKey(): string | undefined {
    return this.config.get<string>('MAPBOX_TOKEN');
  }

  /**
   * Geocode an address. Returns null when it genuinely cannot be found — which the
   * caller must treat as "we can't verify this is in range", NOT as "it's fine".
   */
  async geocode(address: GeocodableAddress): Promise<GeoPoint | null> {
    const query = this.formatQuery(address);
    const cacheKey = `geo:${Buffer.from(query.toLowerCase()).toString('base64').slice(0, 80)}`;

    const cached = await this.redis.get<GeoPoint | { miss: true }>(cacheKey);
    if (cached) {
      // Cache misses too — an unfindable address is unfindable on the retry, and
      // re-asking Google about it on every checkout attempt is money for nothing.
      return 'miss' in cached ? null : cached;
    }

    try {
      const point = await withRetry(() => this.lookup(query, address.country), {
        attempts: 2,
        baseDelayMs: 300,
        label: 'geocode',
        logger: this.logger,
      });

      await this.redis.set(
        cacheKey,
        point ?? { miss: true },
        // Cache a miss briefly: a new-build street may be added to OSM next month.
        point ? GeocodingService.CACHE_TTL_SECONDS : 60 * 60,
      );

      return point;
    } catch (err) {
      // A geocoder outage must not block checkout — see the caller, which treats a
      // null as "cannot verify" and falls back to letting Uber decide.
      this.logger.error(`Geocoding failed for "${query}": ${(err as Error).message}`);
      return null;
    }
  }

  private async lookup(query: string, country: string): Promise<GeoPoint | null> {
    if (this.googleKey) return this.google(query);
    if (this.mapboxKey) return this.mapbox(query, country);
    return this.nominatim(query);
  }

  private async google(query: string): Promise<GeoPoint | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('key', this.googleKey!);

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Google geocoder ${res.status}`);

    const body = (await res.json()) as {
      status: string;
      results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
    };

    if (body.status === 'ZERO_RESULTS') return null;
    if (body.status !== 'OK') throw new Error(`Google geocoder: ${body.status}`);

    const loc = body.results[0]?.geometry.location;
    return loc ? { latitude: loc.lat, longitude: loc.lng } : null;
  }

  private async mapbox(query: string, country: string): Promise<GeoPoint | null> {
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`,
    );
    url.searchParams.set('access_token', this.mapboxKey!);
    url.searchParams.set('limit', '1');
    url.searchParams.set('country', country.toLowerCase());

    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Mapbox geocoder ${res.status}`);

    const body = (await res.json()) as { features: Array<{ center: [number, number] }> };
    const center = body.features[0]?.center;

    // Mapbox returns [lng, lat] — the opposite order to everything else here, and
    // a classic way to end up delivering to the middle of the ocean.
    return center ? { latitude: center[1], longitude: center[0] } : null;
  }

  private async nominatim(query: string): Promise<GeoPoint | null> {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');

    const res = await fetch(url, {
      // Nominatim's policy REQUIRES a real identifying User-Agent. Omitting it gets
      // you blocked, and rightly so.
      headers: { 'User-Agent': 'OrderOS/1.0 (restaurant ordering platform)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);

    const body = (await res.json()) as Array<{ lat: string; lon: string }>;
    const first = body[0];

    return first ? { latitude: parseFloat(first.lat), longitude: parseFloat(first.lon) } : null;
  }

  private formatQuery(a: GeocodableAddress): string {
    return [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ');
  }

  /**
   * Is this address inside the restaurant's own delivery radius?
   *
   * Lives HERE rather than on DeliveryService because both the order engine and the
   * delivery engine need it, and Orders already has a circular dependency on
   * Delivery. Geocoding depends on nothing, so everyone can use it freely.
   *
   * Checked BEFORE we ask Uber anything: every quote costs an API call to produce a
   * "no" for a delivery the restaurant would never have accepted anyway.
   *
   * Returns `null` when we cannot geocode. Callers MUST treat that as "cannot
   * verify" and let Uber decide — failing a paying customer's dinner because our
   * geocoder had a bad afternoon would be us breaking a restaurant's business over
   * our own outage.
   */
  async checkRadius(
    restaurant: GeocodableAddress & {
      latitude: number | null;
      longitude: number | null;
      deliveryRadiusMeters: number;
    },
    dropoff: GeocodableAddress,
  ): Promise<{ withinRadius: boolean; distanceMeters: number } | null> {
    // Older tenants were created before geocoding existed and have no coordinates.
    const origin: GeoPoint | null =
      restaurant.latitude != null && restaurant.longitude != null
        ? { latitude: restaurant.latitude, longitude: restaurant.longitude }
        : await this.geocode(restaurant);

    if (!origin) return null;

    const destination = await this.geocode(dropoff);
    if (!destination) return null;

    const distance = distanceMeters(origin, destination);

    return {
      withinRadius: distance <= restaurant.deliveryRadiusMeters,
      distanceMeters: Math.round(distance),
    };
  }
}

/**
 * Great-circle distance in metres.
 *
 * Straight-line, not driving distance. That is deliberate and it is what a
 * "delivery radius" means to a restaurant owner — they think in "3km around me",
 * not "12 minutes of one-way systems". Uber's own quote is the authority on whether
 * a route is actually drivable; this is the restaurant's own policy limit, and it
 * is applied BEFORE we spend money asking Uber.
 */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}
