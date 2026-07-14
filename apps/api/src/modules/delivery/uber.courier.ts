import { Injectable } from '@nestjs/common';
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
import { UberClient, UberClientError, type UberDelivery } from './uber.client';

/**
 * Uber Direct, wearing the Courier interface.
 *
 * A thin adapter on purpose. UberClient already works, is tested, and handles the
 * genuinely fiddly parts (OAuth token refresh, 401 retry, HMAC webhooks); rewriting
 * it to fit a new interface would be a large diff whose only achievement is the
 * chance to break a working integration. So it stays exactly as it is, and this
 * class does nothing but translate vocabulary.
 */
@Injectable()
export class UberCourier implements Courier {
  readonly provider: DeliveryProvider = 'UBER';

  constructor(private readonly uber: UberClient) {}

  get isConfigured(): boolean {
    return this.uber.isConfigured;
  }

  async quote(req: CourierQuoteRequest): Promise<CourierQuote> {
    try {
      const quote = await this.uber.createQuote({
        pickup_address: UberClient.formatAddress(req.pickup),
        dropoff_address: UberClient.formatAddress(req.dropoff),
        pickup_latitude: req.pickup.latitude ?? undefined,
        pickup_longitude: req.pickup.longitude ?? undefined,
        dropoff_latitude: req.dropoff.latitude ?? undefined,
        dropoff_longitude: req.dropoff.longitude ?? undefined,
        pickup_ready_dt: req.pickupReadyAt.toISOString(),
        manifest_total_value: req.orderValueCents,
      });

      return {
        provider: this.provider,
        quoteId: quote.id,
        feeCents: quote.fee,
        currency: quote.currency,
        expiresAt: quote.expires ? new Date(quote.expires) : null,
        dropoffEta: quote.dropoff_eta ? new Date(quote.dropoff_eta) : null,
        durationMinutes: quote.duration ?? null,
      };
    } catch (err) {
      throw this.translate(err);
    }
  }

  async createDelivery(req: CourierDeliveryRequest): Promise<CourierDelivery> {
    try {
      const delivery = await this.uber.createDelivery({
        pickup_name: req.restaurantName,
        pickup_business_name: req.restaurantName,
        pickup_address: UberClient.formatAddress(req.pickup),
        pickup_phone_number: req.restaurantPhone,
        pickup_latitude: req.pickup.latitude ?? undefined,
        pickup_longitude: req.pickup.longitude ?? undefined,
        // The courier reads this in their driver app on arrival. Leading with the code
        // is what lets staff say "read me your code" and actually get one back.
        pickup_notes: req.pickupCode
          ? `PICKUP CODE: ${req.pickupCode} — order #${req.orderNumber}. Staff will ask you for this code.`
          : `Order #${req.orderNumber}`,

        dropoff_name: req.customerName,
        dropoff_address: UberClient.formatAddress(req.dropoff),
        dropoff_phone_number: req.customerPhone,
        dropoff_latitude: req.dropoff.latitude ?? undefined,
        dropoff_longitude: req.dropoff.longitude ?? undefined,
        dropoff_notes: req.dropoffNotes ?? undefined,

        // `size` is required by Uber and drives which vehicle they send. We do not ask
        // restaurants to classify every dish, and guessing 'large' would put a car on
        // a burrito. 'small' is the honest default for prepared food in a bag; a
        // restaurant shipping a catering tray is not a case this product serves yet.
        manifest_items: req.items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          size: 'small' as const,
        })),
        manifest_total_value: req.orderValueCents,
        quote_id: req.quoteId ?? undefined,
        tip: req.tip ?? undefined,
      });

      return this.toDelivery(delivery);
    } catch (err) {
      throw this.translate(err);
    }
  }

  async getDelivery(deliveryId: string): Promise<CourierDelivery> {
    try {
      return this.toDelivery(await this.uber.getDelivery(deliveryId));
    } catch (err) {
      throw this.translate(err);
    }
  }

  async cancelDelivery(deliveryId: string): Promise<void> {
    try {
      await this.uber.cancelDelivery(deliveryId);
    } catch (err) {
      throw this.translate(err);
    }
  }

  verifyWebhookSignature(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    return this.uber.verifyWebhookSignature(rawBody, headers['x-postmates-signature']);
  }

  /**
   * Uber's errors, in the pipeline's vocabulary.
   *
   * UberClientError is a 4xx, which for a courier almost always means "we don't
   * deliver to that address" — a normal answer to give a customer, not an outage.
   * Everything else is treated as the courier being broken, which IS retryable and
   * may be worth failing over to DoorDash for.
   */
  private translate(err: unknown): Error {
    if (err instanceof UberClientError) {
      return new CourierDeclinedError(err.message, this.provider);
    }
    if (err instanceof Error) {
      return new CourierUnavailableError(err.message, this.provider);
    }
    return new CourierUnavailableError('Uber Direct failed', this.provider);
  }

  private toDelivery(d: UberDelivery): CourierDelivery {
    const courier = d.courier;

    return {
      provider: this.provider,
      deliveryId: d.id,
      quoteId: d.quote_id ?? null,
      status: mapStatus(d.status),
      feeCents: d.fee ?? null,
      currency: d.currency ?? 'USD',
      trackingUrl: d.tracking_url ?? null,
      pickupEta: d.pickup_eta ? new Date(d.pickup_eta) : null,
      dropoffEta: d.dropoff_eta ? new Date(d.dropoff_eta) : null,
      courier: courier
        ? {
            name: courier.name ?? null,
            phone: courier.phone_number ?? null,
            vehicle: courier.vehicle_type ?? null,
            latitude: courier.location?.lat ?? null,
            longitude: courier.location?.lng ?? null,
          }
        : null,
    };
  }
}

/**
 * Uber's status vocabulary, flattened to the states the order pipeline acts on.
 *
 * Exported because the WEBHOOK path needs it too: an inbound Uber event carries a raw
 * status string, and it has to be flattened at the edge so that everything downstream
 * — the state machine, the customer's notifications, the hunt for a replacement
 * courier — is provider-neutral.
 */
export function mapUberStatus(status: string | undefined): CourierStatus {
  return mapStatus(status);
}

function mapStatus(status: string | undefined): CourierStatus {
  switch (status) {
    case 'pending':
      return 'CREATED';
    case 'pickup':
    case 'pickup_complete':
      return 'COURIER_ASSIGNED';
    case 'dropoff':
      return 'PICKED_UP';
    case 'delivered':
      return 'DELIVERED';
    case 'canceled':
    case 'cancelled':
      return 'CANCELLED';
    case 'returned':
      return 'FAILED';
    default:
      // An unknown status is NOT a failure. Uber can add states, and treating a new
      // one as a failed delivery would cancel a courier who is riding along happily.
      return 'CREATED';
  }
}
