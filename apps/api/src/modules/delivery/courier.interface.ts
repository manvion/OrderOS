import type { DeliveryProvider } from '@prisma/client';

/**
 * The one shape every courier is squeezed into.
 *
 * Uber Direct and DoorDash Drive do the same job and agree on almost nothing: Uber
 * mints the delivery id, DoorDash makes YOU mint it; Uber quotes and dispatches in
 * two independent calls, DoorDash wants you to accept the quote you were given; they
 * name every field differently and their status vocabularies only partly overlap.
 *
 * None of that is interesting to the order pipeline, which wants to ask exactly four
 * questions — what will this cost, please send someone, where are they, stop — and
 * get the same answer shape back regardless of who is riding the bike. So the
 * per-courier weirdness is confined to the adapters, and everything above this line
 * is provider-agnostic.
 */

export interface CourierAddress {
  street: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface CourierQuoteRequest {
  pickup: CourierAddress;
  dropoff: CourierAddress;
  /** When the food will actually be ready. Quoting a courier for "now" when the food
   *  needs 20 more minutes buys you a rider standing in the kitchen, on the clock. */
  pickupReadyAt: Date;
  /** Declared value of the food, for the courier's insurance. */
  orderValueCents: number;
  /** Stable per-order key. DoorDash requires we mint the delivery id ourselves. */
  externalId: string;
}

export interface CourierQuote {
  provider: DeliveryProvider;
  /** Pass back to `createDelivery` to dispatch against THIS price. */
  quoteId: string;
  /** What the courier will charge the restaurant. The number we compare on. */
  feeCents: number;
  currency: string;
  /** After this, the price is no longer honoured and must be re-quoted. */
  expiresAt: Date | null;
  dropoffEta: Date | null;
  durationMinutes: number | null;
}

export interface CourierDeliveryRequest extends CourierQuoteRequest {
  quoteId: string | null;
  restaurantName: string;
  restaurantPhone: string;
  customerName: string;
  customerPhone: string;
  orderNumber: string;
  /** Buzzer codes, gate instructions — what actually determines a successful drop. */
  dropoffNotes?: string | null;
  /**
   * The handoff code, printed on the bag label and shown to the courier in their
   * driver app. Staff ask "what's your code?"; it either matches the bag or it
   * doesn't. See the Delivery model for why this is not the order number.
   */
  pickupCode?: string | null;
  items: Array<{ name: string; quantity: number }>;
}

/** Every courier's native status, flattened to the ones the order pipeline acts on. */
export type CourierStatus =
  | 'PENDING'
  | 'CREATED'
  | 'COURIER_ASSIGNED'
  | 'PICKED_UP'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'FAILED';

export interface CourierDelivery {
  provider: DeliveryProvider;
  /** The courier's id for this delivery. Meaningless to any OTHER courier's API. */
  deliveryId: string;
  quoteId: string | null;
  status: CourierStatus;
  feeCents: number | null;
  currency: string;
  trackingUrl: string | null;
  pickupEta: Date | null;
  dropoffEta: Date | null;
  courier: {
    name: string | null;
    phone: string | null;
    vehicle: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
}

/**
 * Thrown when the courier says no for a reason the CUSTOMER caused — address outside
 * the delivery zone, address not real, order too large. These are normal answers, not
 * failures: they must be shown to the customer as plain text, never retried, and
 * never allowed to 500 a checkout page.
 */
export class CourierDeclinedError extends Error {
  constructor(
    message: string,
    readonly provider: DeliveryProvider,
  ) {
    super(message);
    this.name = 'CourierDeclinedError';
  }
}

/**
 * Thrown when the courier itself broke — 5xx, timeout, auth failure. Retryable, and
 * the caller SHOULD retry, possibly against a different courier. Distinct from
 * CourierDeclinedError because retrying a declined address just declines again, and
 * failing over a genuine outage strands a paid order.
 */
export class CourierUnavailableError extends Error {
  constructor(
    message: string,
    readonly provider: DeliveryProvider,
  ) {
    super(message);
    this.name = 'CourierUnavailableError';
  }
}

/**
 * What a courier must be able to do. Implemented once per courier; consumed only by
 * CourierRouter, never by the order pipeline directly.
 */
export interface Courier {
  readonly provider: DeliveryProvider;

  /** False when the credentials aren't configured. The router simply skips it. */
  readonly isConfigured: boolean;

  quote(req: CourierQuoteRequest): Promise<CourierQuote>;

  createDelivery(req: CourierDeliveryRequest): Promise<CourierDelivery>;

  getDelivery(deliveryId: string): Promise<CourierDelivery>;

  cancelDelivery(deliveryId: string): Promise<void>;

  /** Verify a webhook against the RAW bytes. Never the parsed body — see main.ts. */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string | undefined>): boolean;
}
