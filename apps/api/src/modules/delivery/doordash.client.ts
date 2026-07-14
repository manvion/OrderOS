import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DeliveryProvider } from '@prisma/client';
import { withRetry } from '../../common/resilience/retry';
import {
  CourierDeclinedError,
  CourierUnavailableError,
  type Courier,
  type CourierAddress,
  type CourierDelivery,
  type CourierDeliveryRequest,
  type CourierQuote,
  type CourierQuoteRequest,
  type CourierStatus,
} from './courier.interface';

/**
 * DoorDash Drive — white-label couriers in the US, Canada, Australia and NZ.
 *
 * Three things about Drive differ from Uber Direct in ways that matter here:
 *
 *  1. AUTH IS A SELF-SIGNED JWT, not OAuth. There is no token endpoint to call and
 *     nothing to cache: we mint a short-lived HS256 token per request from the
 *     credentials. Note the secret is base64url-ENCODED — signing with the raw ASCII
 *     string produces a token that looks perfectly well-formed and is rejected every
 *     time, which is a genuinely miserable afternoon.
 *
 *  2. WE MINT THE DELIVERY ID (`external_delivery_id`), not DoorDash. That is
 *     strictly better: it makes create idempotent for free. Retrying a dispatch with
 *     the same id returns the EXISTING delivery instead of sending a second courier
 *     to the same bag of food, which is exactly the failure the Redis lock in
 *     DeliveryService exists to prevent.
 *
 *  3. QUOTE AND DISPATCH ARE THE SAME OBJECT. You quote, then ACCEPT that quote by
 *     id. There is no way to dispatch at a price you were never quoted, so the quote
 *     is not advisory the way Uber's is.
 */
@Injectable()
export class DoorDashClient implements Courier {
  readonly provider: DeliveryProvider = 'DOORDASH';

  private readonly logger = new Logger(DoorDashClient.name);
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      this.config.get<string>('DOORDASH_API_BASE_URL') ?? 'https://openapi.doordash.com';
  }

  private get developerId(): string | undefined {
    return this.config.get<string>('DOORDASH_DEVELOPER_ID');
  }

  private get keyId(): string | undefined {
    return this.config.get<string>('DOORDASH_KEY_ID');
  }

  private get signingSecret(): string | undefined {
    return this.config.get<string>('DOORDASH_SIGNING_SECRET');
  }

  get isConfigured(): boolean {
    return Boolean(this.developerId && this.keyId && this.signingSecret);
  }

  // --- Auth -----------------------------------------------------------------

  /**
   * A DoorDash Drive JWT. Hand-rolled rather than pulling in `jsonwebtoken`, because
   * it is fifteen lines of HMAC and Drive needs a non-standard `dd-ver` header that
   * most JWT libraries make awkward to set anyway.
   */
  private mintToken(): string {
    const header = {
      alg: 'HS256',
      typ: 'JWT',
      // Drive rejects the token without this. It is not part of any JWT standard.
      'dd-ver': 'DD-JWT-V1',
    };

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      aud: 'doordash',
      iss: this.developerId,
      kid: this.keyId,
      iat: now,
      // Short-lived by design: it is minted per request, so there is no reason to
      // hand out a token that outlives the call it was made for.
      exp: now + 300,
    };

    const encode = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString('base64url');

    const signingInput = `${encode(header)}.${encode(payload)}`;

    // THE base64url decode. See the class comment: the signing secret DoorDash gives
    // you is base64url text, and HMAC-ing with the literal string silently produces
    // a token that is rejected with an unhelpful 401.
    const key = Buffer.from(this.signingSecret!, 'base64url');

    const signature = createHmac('sha256', key).update(signingInput).digest('base64url');

    return `${signingInput}.${signature}`;
  }

  // --- HTTP -----------------------------------------------------------------

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this.isConfigured) {
      throw new CourierUnavailableError('DoorDash Drive is not configured', this.provider);
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.mintToken()}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Network failure or timeout. Retryable, and possibly failover-able.
      throw new CourierUnavailableError(
        `DoorDash Drive unreachable: ${(err as Error).message}`,
        this.provider,
      );
    }

    const text = await res.text();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

    if (res.ok) return body as T;

    const message =
      (typeof body.message === 'string' && body.message) ||
      (typeof body.code === 'string' && body.code) ||
      `DoorDash Drive ${res.status}`;

    /**
     * 4xx means DoorDash understood us and said no — almost always because the
     * address is outside a delivery zone, isn't real, or the order is too big. That
     * is a normal answer to give a customer, not an outage: retrying it just gets the
     * same no, and 500ing the checkout page over it would be a lie.
     *
     * 429 is the exception. It is a 4xx, but it means "ask again shortly", so it
     * belongs with the retryable failures.
     */
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      throw new CourierDeclinedError(message, this.provider);
    }

    throw new CourierUnavailableError(message, this.provider);
  }

  // --- Courier --------------------------------------------------------------

  async quote(req: CourierQuoteRequest): Promise<CourierQuote> {
    const body = await withRetry(
      () =>
        this.request<DoorDashQuoteResponse>('/drive/v2/quotes', {
          method: 'POST',
          body: JSON.stringify({
            external_delivery_id: req.externalId,
            pickup_address: formatAddress(req.pickup),
            dropoff_address: formatAddress(req.dropoff),
            order_value: req.orderValueCents,
            pickup_time: req.pickupReadyAt.toISOString(),
          }),
        }),
      {
        attempts: 2,
        baseDelayMs: 300,
        label: 'doordash-quote',
        logger: this.logger,
        // A decline is a final answer. Retrying it burns time and gets the same no.
        isRetryable: (err) => !(err instanceof CourierDeclinedError),
      },
    );

    return {
      provider: this.provider,
      // Drive has no separate quote id — the external id we minted IS the handle, and
      // accepting the quote dispatches against it.
      quoteId: body.external_delivery_id,
      feeCents: body.fee,
      currency: body.currency?.toUpperCase() ?? 'USD',
      expiresAt: body.quote_expiration_time ? new Date(body.quote_expiration_time) : null,
      dropoffEta: body.dropoff_time_estimated ? new Date(body.dropoff_time_estimated) : null,
      durationMinutes: body.duration ?? null,
    };
  }

  async createDelivery(req: CourierDeliveryRequest): Promise<CourierDelivery> {
    /**
     * Accept the quote we were given, if we have one. If we don't (a retry whose
     * quote has since expired), fall through to creating the delivery outright —
     * Drive accepts a create without a prior quote and prices it at dispatch.
     *
     * Either path is idempotent on `external_delivery_id`, which is the property that
     * makes a retry safe: it returns the delivery that already exists rather than
     * sending a SECOND courier to collect the same bag.
     */
    const body = req.quoteId
      ? await this.request<DoorDashDeliveryResponse>(
          `/drive/v2/quotes/${encodeURIComponent(req.quoteId)}/accept`,
          // The tip isn't known at quote time (checkout hasn't happened yet), so it
          // rides in here instead -- an empty body accepted the quote but silently
          // dropped the tip the customer had already paid.
          { method: 'POST', body: JSON.stringify({ tip: req.tip ?? undefined }) },
        )
      : await this.request<DoorDashDeliveryResponse>('/drive/v2/deliveries', {
          method: 'POST',
          body: JSON.stringify({
            external_delivery_id: req.externalId,
            pickup_address: formatAddress(req.pickup),
            pickup_business_name: req.restaurantName,
            pickup_phone_number: req.restaurantPhone,
            // The courier reads this in their driver app on arrival. Leading with the
            // code is what lets staff say "read me your code" and actually get one.
            pickup_instructions: req.pickupCode
              ? `PICKUP CODE: ${req.pickupCode} — order #${req.orderNumber}. Staff will ask you for this code.`
              : `Order #${req.orderNumber}`,
            dropoff_address: formatAddress(req.dropoff),
            dropoff_phone_number: req.customerPhone,
            dropoff_contact_given_name: req.customerName,
            dropoff_instructions: req.dropoffNotes ?? undefined,
            order_value: req.orderValueCents,
            pickup_time: req.pickupReadyAt.toISOString(),
            items: req.items.map((i) => ({ name: i.name, quantity: i.quantity })),
            tip: req.tip ?? undefined,
          }),
        });

    return this.toDelivery(body);
  }

  async getDelivery(deliveryId: string): Promise<CourierDelivery> {
    return this.toDelivery(
      await this.request<DoorDashDeliveryResponse>(
        `/drive/v2/deliveries/${encodeURIComponent(deliveryId)}`,
      ),
    );
  }

  async cancelDelivery(deliveryId: string): Promise<void> {
    await this.request(`/drive/v2/deliveries/${encodeURIComponent(deliveryId)}/cancel`, {
      method: 'PUT',
    });
  }

  /**
   * Drive signs the RAW request bytes with the same signing secret, HMAC-SHA256,
   * base64. Verifying against a re-serialized JSON body will fail on key order and
   * whitespace alone — which is why main.ts keeps the raw Buffer for this route.
   */
  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const secret = this.config.get<string>('DOORDASH_WEBHOOK_SECRET') ?? this.signingSecret;
    if (!secret) return false;

    const signature = headers['x-doordash-signature'];
    if (!signature) return false;

    const expected = createHmac('sha256', Buffer.from(secret, 'base64url'))
      .update(rawBody)
      .digest('base64');

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    // Length check first: timingSafeEqual THROWS on a length mismatch rather than
    // returning false, which would turn a malformed signature into a 500.
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  }

  // --- Mapping --------------------------------------------------------------

  private toDelivery(body: DoorDashDeliveryResponse): CourierDelivery {
    const hasCourier = Boolean(body.dasher_name ?? body.dasher_phone_number);

    return {
      provider: this.provider,
      deliveryId: body.external_delivery_id,
      quoteId: body.external_delivery_id,
      status: mapStatus(body.delivery_status),
      feeCents: body.fee ?? null,
      currency: body.currency?.toUpperCase() ?? 'USD',
      trackingUrl: body.tracking_url ?? null,
      pickupEta: body.pickup_time_estimated ? new Date(body.pickup_time_estimated) : null,
      dropoffEta: body.dropoff_time_estimated ? new Date(body.dropoff_time_estimated) : null,
      courier: hasCourier
        ? {
            name: body.dasher_name ?? null,
            phone: body.dasher_phone_number ?? null,
            vehicle: body.dasher_vehicle_make
              ? [body.dasher_vehicle_make, body.dasher_vehicle_model].filter(Boolean).join(' ')
              : null,
            latitude: body.dasher_location?.lat ?? null,
            longitude: body.dasher_location?.lng ?? null,
          }
        : null,
    };
  }
}

/**
 * Drive's status vocabulary, flattened to the states the order pipeline acts on.
 *
 * The intermediate ones (enroute_to_pickup, arrived_at_pickup, enroute_to_dropoff…)
 * are real and useful for a tracking map, but the pipeline treats them all as "a
 * courier is assigned and moving". Collapsing them here means the state machine has
 * one meaning per state rather than seven aliases for two.
 */
export function mapDoorDashStatus(status: string | undefined): CourierStatus {
  return mapStatus(status);
}

function mapStatus(status: string | undefined): CourierStatus {
  switch (status) {
    case 'quote':
      return 'PENDING';
    case 'created':
    case 'confirmed':
      return 'CREATED';
    case 'enroute_to_pickup':
    case 'arrived_at_pickup':
      return 'COURIER_ASSIGNED';
    case 'picked_up':
    case 'enroute_to_dropoff':
    case 'arrived_at_dropoff':
      return 'PICKED_UP';
    case 'delivered':
      return 'DELIVERED';
    case 'cancelled':
      return 'CANCELLED';
    default:
      // An unknown status is NOT a failure — Drive can add states, and treating a new
      // one as a failed delivery would cancel a courier who is happily riding along.
      // Report the safest thing we know to be true: it exists and it isn't finished.
      return 'CREATED';
  }
}

function formatAddress(a: CourierAddress): string {
  return [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ');
}

// --- Wire types -------------------------------------------------------------

interface DoorDashQuoteResponse {
  external_delivery_id: string;
  fee: number;
  currency?: string;
  quote_expiration_time?: string;
  dropoff_time_estimated?: string;
  duration?: number;
}

interface DoorDashDeliveryResponse {
  external_delivery_id: string;
  delivery_status?: string;
  fee?: number;
  currency?: string;
  tracking_url?: string;
  pickup_time_estimated?: string;
  dropoff_time_estimated?: string;
  dasher_name?: string;
  dasher_phone_number?: string;
  dasher_vehicle_make?: string;
  dasher_vehicle_model?: string;
  dasher_location?: { lat: number; lng: number };
}
