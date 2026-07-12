import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.service';
import { withRetry } from '../../common/resilience/retry';

/** A structured address, in the shape the rest of the app already speaks. */
export interface ResolvedAddress {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  /** The provider's own one-line rendering — what the customer clicked on. */
  formatted: string;
}

export interface AddressSuggestion {
  /** Opaque to the client. Pass it back to `resolve()` verbatim. */
  id: string;
  /** The bold part: "221B Baker Street". */
  primary: string;
  /** The grey part: "London, UK". */
  secondary: string;
}

/**
 * Address autocomplete — "did you mean this exact address?".
 *
 * A typed delivery address is the single most expensive free-text field in the
 * product. Get it slightly wrong and the food is cooked, paid for, dispatched, and
 * delivered to a house that didn't order it. Nobody gets that money back. So we
 * push customers to PICK a real, geocoded address rather than type one, and we keep
 * the coordinates the provider gave us instead of re-deriving them later from a
 * string we already know is fragile.
 *
 * PROVIDERS, in order:
 *
 *   1. Google Places — best coverage, and the only one that copes with how Indian
 *      addresses are actually written ("opp. Krishna Bakery, near the temple").
 *      Billed per SESSION, not per keystroke, which is why `sessionToken` below is
 *      load-bearing rather than decorative.
 *   2. Mapbox — cheaper, fine in US/CA/EU, materially worse in India.
 *
 * If neither key is set the service reports itself UNAVAILABLE rather than guessing.
 * The checkout form then falls back to plain manual entry, which still works — this
 * is an accelerant, never a gate. A restaurant with no Google key must still be able
 * to take an order.
 */
@Injectable()
export class AddressAutocompleteService {
  private readonly logger = new Logger(AddressAutocompleteService.name);

  /**
   * How long a resolved suggestion stays fetchable.
   *
   * `resolve()` reads what `suggest()` cached rather than calling the provider a
   * second time — Mapbox already returns the full structured address in the
   * autocomplete response, so paying for a second "details" round-trip would be
   * buying data we were handed for free. Ten minutes comfortably outlives the
   * checkout it belongs to without pinning dead entries in Redis.
   */
  private static readonly RESOLVED_TTL_SECONDS = 10 * 60;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  private get googleKey(): string | undefined {
    return this.config.get<string>('GOOGLE_MAPS_API_KEY');
  }

  private get mapboxKey(): string | undefined {
    return this.config.get<string>('MAPBOX_TOKEN');
  }

  /**
   * Is autocomplete usable at all? The storefront asks this so it can render a plain
   * text field instead of a picker that would never return anything.
   */
  get available(): boolean {
    return Boolean(this.googleKey ?? this.mapboxKey);
  }

  /**
   * A Google Places session groups every keystroke of one address search plus the
   * final details call into a SINGLE billable unit. Without it, Google bills each
   * keystroke as its own autocomplete request and a customer typing a 30-character
   * address costs ~30x what it should. The client mints one of these per address
   * field and hands it back on every call for that field.
   */
  newSessionToken(): string {
    return randomUUID();
  }

  /**
   * Suggestions for a partial address. Returns `[]` rather than throwing: a dead
   * geocoder must degrade to manual entry, never block a checkout.
   */
  async suggest(
    query: string,
    country: string,
    sessionToken: string,
  ): Promise<AddressSuggestion[]> {
    // Below three characters every provider returns either noise or the whole
    // country, and each call costs money.
    if (query.trim().length < 3) return [];

    try {
      if (this.googleKey) return await withRetry(() => this.googleSuggest(query, country, sessionToken), {
        attempts: 2,
        baseDelayMs: 250,
        label: 'places-autocomplete',
        logger: this.logger,
      });

      if (this.mapboxKey) return await withRetry(() => this.mapboxSuggest(query, country), {
        attempts: 2,
        baseDelayMs: 250,
        label: 'mapbox-autocomplete',
        logger: this.logger,
      });

      return [];
    } catch (err) {
      this.logger.error(`Address autocomplete failed for "${query}": ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * Turn a suggestion the customer picked into a full structured address.
   *
   * Returns null if the suggestion is unknown or expired — the caller must then keep
   * whatever the customer typed rather than silently substituting nothing.
   */
  async resolve(id: string, sessionToken: string): Promise<ResolvedAddress | null> {
    // Mapbox suggestions were fully resolved at suggest() time and parked in Redis.
    const cached = await this.redis.get<ResolvedAddress>(this.resolvedKey(id));
    if (cached) return cached;

    // Google's autocomplete returns only a place_id; the address itself costs a
    // second call. Inside the same session token, that call is billed as part of the
    // session we already paid for.
    if (this.googleKey && id.startsWith('g:')) {
      try {
        return await this.googleDetails(id.slice(2), sessionToken);
      } catch (err) {
        this.logger.error(`Place details failed for ${id}: ${(err as Error).message}`);
        return null;
      }
    }

    return null;
  }

  // --- Google ---------------------------------------------------------------

  private async googleSuggest(
    query: string,
    country: string,
    sessionToken: string,
  ): Promise<AddressSuggestion[]> {
    const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
    url.searchParams.set('input', query);
    url.searchParams.set('key', this.googleKey!);
    url.searchParams.set('sessiontoken', sessionToken);
    // Bias to the restaurant's country. A Toronto customer should not be offered a
    // street in Texas because it shares a name.
    url.searchParams.set('components', `country:${country.toLowerCase()}`);
    url.searchParams.set('types', 'address');

    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Google Places ${res.status}`);

    const body = (await res.json()) as {
      status: string;
      predictions: Array<{
        place_id: string;
        structured_formatting: { main_text: string; secondary_text?: string };
      }>;
    };

    if (body.status === 'ZERO_RESULTS') return [];
    if (body.status !== 'OK') throw new Error(`Google Places: ${body.status}`);

    return body.predictions.map((p) => ({
      // Prefixed so resolve() knows which provider minted it — the two are not
      // interchangeable and a Mapbox id sent to Google is a confusing 404.
      id: `g:${p.place_id}`,
      primary: p.structured_formatting.main_text,
      secondary: p.structured_formatting.secondary_text ?? '',
    }));
  }

  private async googleDetails(placeId: string, sessionToken: string): Promise<ResolvedAddress | null> {
    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('key', this.googleKey!);
    url.searchParams.set('sessiontoken', sessionToken);
    // Ask for ONLY what we store. Google bills Place Details by which field groups
    // you request, so requesting the default "everything" is a pure waste.
    url.searchParams.set('fields', 'address_component,geometry,formatted_address');

    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Google Place Details ${res.status}`);

    const body = (await res.json()) as {
      status: string;
      result?: {
        formatted_address: string;
        geometry: { location: { lat: number; lng: number } };
        address_components: Array<{ long_name: string; short_name: string; types: string[] }>;
      };
    };

    if (body.status !== 'OK' || !body.result) return null;

    const parts = body.result.address_components;
    const pick = (type: string, short = false): string => {
      const c = parts.find((p) => p.types.includes(type));
      return c ? (short ? c.short_name : c.long_name) : '';
    };

    const streetNumber = pick('street_number');
    const route = pick('route');

    return {
      street: [streetNumber, route].filter(Boolean).join(' '),
      // `locality` is absent in big chunks of the UK (which uses postal_town) and in
      // much of India (which uses sublocality). Falling through the three is the
      // difference between a usable city field and an empty one.
      city: pick('locality') || pick('postal_town') || pick('sublocality_level_1') || pick('sublocality'),
      // Short name: "ON", not "Ontario". Couriers and tax tables both key off the code.
      state: pick('administrative_area_level_1', true),
      postalCode: pick('postal_code'),
      country: pick('country', true),
      latitude: body.result.geometry.location.lat,
      longitude: body.result.geometry.location.lng,
      formatted: body.result.formatted_address,
    };
  }

  // --- Mapbox ---------------------------------------------------------------

  private async mapboxSuggest(query: string, country: string): Promise<AddressSuggestion[]> {
    const url = new URL(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`,
    );
    url.searchParams.set('access_token', this.mapboxKey!);
    url.searchParams.set('autocomplete', 'true');
    url.searchParams.set('country', country.toLowerCase());
    url.searchParams.set('types', 'address');
    url.searchParams.set('limit', '5');

    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`Mapbox autocomplete ${res.status}`);

    const body = (await res.json()) as {
      features: Array<{
        id: string;
        text: string;
        address?: string;
        place_name: string;
        center: [number, number];
        context?: Array<{ id: string; text: string; short_code?: string }>;
      }>;
    };

    const suggestions: AddressSuggestion[] = [];

    for (const f of body.features) {
      const ctx = (prefix: string) => f.context?.find((c) => c.id.startsWith(`${prefix}.`));

      const region = ctx('region');
      const countryCtx = ctx('country');

      const resolved: ResolvedAddress = {
        // Mapbox splits the house number (`address`) from the street (`text`).
        street: [f.address, f.text].filter(Boolean).join(' '),
        city: ctx('place')?.text ?? ctx('locality')?.text ?? '',
        // short_code is "CA-ON"; we want "ON". Falls back to the full name.
        state: region?.short_code?.split('-')[1] ?? region?.text ?? '',
        postalCode: ctx('postcode')?.text ?? '',
        country: countryCtx?.short_code?.toUpperCase() ?? country.toUpperCase(),
        // Mapbox returns [lng, lat] — the reverse of everything else in this codebase,
        // and a well-worn way to deliver dinner to the middle of the Atlantic.
        latitude: f.center[1],
        longitude: f.center[0],
        formatted: f.place_name,
      };

      const id = `m:${f.id}`;

      // Mapbox hands us the whole structured address in the autocomplete response, so
      // stash it now and let resolve() read it back. Re-querying Mapbox on click would
      // be a second billable call for data already in hand.
      await this.redis.set(
        this.resolvedKey(id),
        resolved,
        AddressAutocompleteService.RESOLVED_TTL_SECONDS,
      );

      const [primary, ...rest] = f.place_name.split(', ');

      suggestions.push({
        id,
        primary: primary ?? f.text,
        secondary: rest.join(', '),
      });
    }

    return suggestions;
  }

  private resolvedKey(id: string): string {
    return `addr:resolved:${id}`;
  }
}
