import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DeliveryProvider } from '@prisma/client';
import {
  CourierDeclinedError,
  CourierUnavailableError,
  type Courier,
  type CourierDelivery,
  type CourierDeliveryRequest,
  type CourierQuote,
  type CourierQuoteRequest,
  type CourierStatus,
} from './courier.interface';

/**
 * Porter — India intracity courier, the auto-dispatch option for India where Uber
 * Direct and DoorDash Drive don't operate (see paymentProviderForCountry).
 *
 * Squeezed into the same Courier interface as Uber/DoorDash so the order pipeline
 * neither knows nor cares which bike is riding. Porter quotes and dispatches on
 * COORDINATES, so an address without lat/lng is declined here (the caller geocodes
 * first, exactly as it does for Uber). Guarded by PORTER_API_KEY: with no key it
 * reports `isConfigured: false` and the router simply skips it, so a deployment
 * without a Porter account behaves exactly as before.
 */
@Injectable()
export class PorterCourier implements Courier {
  readonly provider: DeliveryProvider = 'PORTER';
  private readonly logger = new Logger(PorterCourier.name);
  private readonly apiKey?: string;
  private readonly base: string;
  private readonly webhookSecret?: string;

  constructor(private readonly config: ConfigService) {
    this.apiKey = this.config.get<string>('PORTER_API_KEY');
    // UAT vs prod is chosen by env; default to prod host.
    this.base = this.config.get<string>('PORTER_API_BASE') ?? 'https://pfe-apigw.porter.in';
    this.webhookSecret = this.config.get<string>('PORTER_WEBHOOK_SECRET');
  }

  get isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  private async call<T>(method: 'POST' | 'GET', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'X-API-KEY': this.apiKey!,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network/DNS/timeout — the courier itself is unreachable. Retryable.
      throw new CourierUnavailableError((err as Error).message, this.provider);
    }

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message =
        (json.message as string) ?? (json.error as string) ?? `Porter ${res.status}`;
      // 4xx that isn't auth is the customer's address/order being refused — a real,
      // show-to-the-customer answer. 5xx (and 401/403 config errors) are our problem
      // and retryable against another courier.
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
        throw new CourierDeclinedError(message, this.provider);
      }
      throw new CourierUnavailableError(message, this.provider);
    }
    return json as T;
  }

  private coords(a: { latitude?: number | null; longitude?: number | null }): {
    lat: number;
    lng: number;
  } {
    if (a.latitude == null || a.longitude == null) {
      // Porter needs coordinates; an ungeocoded address can't be quoted. Treat as a
      // decline (the customer must pick a resolvable address), not an outage.
      throw new CourierDeclinedError('We could not locate that address', this.provider);
    }
    return { lat: a.latitude, lng: a.longitude };
  }

  async quote(req: CourierQuoteRequest): Promise<CourierQuote> {
    const body = {
      pickup_details: { lat: this.coords(req.pickup).lat, lng: this.coords(req.pickup).lng },
      drop_details: { lat: this.coords(req.dropoff).lat, lng: this.coords(req.dropoff).lng },
    };

    // Porter returns a list of vehicle options with fares; we take the cheapest 2-wheeler
    // suitable for a food bag.
    const res = await this.call<{
      vehicles?: Array<{ type?: string; fare?: { minor_amount?: number }; eta?: { duration?: number } }>;
    }>('POST', '/v1/get_quote', body);

    const options = (res.vehicles ?? []).filter((v) => v.fare?.minor_amount != null);
    if (options.length === 0) {
      throw new CourierDeclinedError('No Porter rider available for that route', this.provider);
    }
    options.sort((a, b) => (a.fare!.minor_amount ?? 0) - (b.fare!.minor_amount ?? 0));
    const best = options[0];
    const durationSecs = best.eta?.duration ?? null;

    return {
      provider: this.provider,
      // Porter re-quotes at create time, so there's no standalone quote id to honour.
      quoteId: best.type ?? 'two_wheeler',
      feeCents: best.fare!.minor_amount!, // Porter is INR paise, our minor unit
      currency: 'INR',
      expiresAt: null,
      dropoffEta: durationSecs ? new Date(Date.now() + durationSecs * 1000) : null,
      durationMinutes: durationSecs ? Math.round(durationSecs / 60) : null,
    };
  }

  async createDelivery(req: CourierDeliveryRequest): Promise<CourierDelivery> {
    const body = {
      request_id: req.externalId,
      delivery_instructions: {
        instructions_list: req.dropoffNotes ? [{ type: 'text', description: req.dropoffNotes }] : [],
      },
      pickup_details: {
        address: {
          ...this.coords(req.pickup),
          contact_details: { name: req.restaurantName, phone_number: req.restaurantPhone },
        },
      },
      drop_details: {
        address: {
          ...this.coords(req.dropoff),
          contact_details: { name: req.customerName, phone_number: req.customerPhone },
        },
      },
    };

    const res = await this.call<{
      order_id?: string;
      tracking_url?: string;
      estimated_fare_details?: { minor_amount?: number };
    }>('POST', '/v1/orders/create', body);

    if (!res.order_id) {
      throw new CourierUnavailableError('Porter did not return an order id', this.provider);
    }

    return {
      provider: this.provider,
      deliveryId: res.order_id,
      quoteId: req.quoteId,
      status: 'CREATED',
      feeCents: res.estimated_fare_details?.minor_amount ?? null,
      currency: 'INR',
      trackingUrl: res.tracking_url ?? null,
      pickupEta: null,
      dropoffEta: null,
      courier: null,
    };
  }

  async getDelivery(deliveryId: string): Promise<CourierDelivery> {
    const res = await this.call<{
      status?: string;
      tracking_url?: string;
      partner_info?: { name?: string; mobile?: { mobile_number?: string }; vehicle_number?: string };
      fare_details?: { minor_amount?: number };
    }>('GET', `/v1/orders/${deliveryId}`);

    return {
      provider: this.provider,
      deliveryId,
      quoteId: null,
      status: this.mapStatus(res.status),
      feeCents: res.fare_details?.minor_amount ?? null,
      currency: 'INR',
      trackingUrl: res.tracking_url ?? null,
      pickupEta: null,
      dropoffEta: null,
      courier: res.partner_info
        ? {
            name: res.partner_info.name ?? null,
            phone: res.partner_info.mobile?.mobile_number ?? null,
            vehicle: res.partner_info.vehicle_number ?? null,
            latitude: null,
            longitude: null,
          }
        : null,
    };
  }

  async cancelDelivery(deliveryId: string): Promise<void> {
    await this.call('POST', `/v1/orders/${deliveryId}/cancel`, {
      cancellation_reason: 'order_cancelled_by_restaurant',
    });
  }

  verifyWebhookSignature(): boolean {
    // Porter signs webhooks with a shared secret; until PORTER_WEBHOOK_SECRET is set
    // and verified end-to-end we don't trust unsigned events (return false so the
    // caller ignores them and relies on polling getDelivery instead).
    return Boolean(this.webhookSecret) && false;
  }

  /** Porter's status vocabulary, flattened to the ones the order pipeline acts on. */
  private mapStatus(status?: string): CourierStatus {
    switch ((status ?? '').toLowerCase()) {
      case 'open':
      case 'created':
        return 'CREATED';
      case 'accepted':
      case 'assigned':
        return 'COURIER_ASSIGNED';
      case 'live':
      case 'started':
      case 'picked_up':
        return 'PICKED_UP';
      case 'ended':
      case 'completed':
      case 'delivered':
        return 'DELIVERED';
      case 'cancelled':
        return 'CANCELLED';
      default:
        return 'PENDING';
    }
  }
}
