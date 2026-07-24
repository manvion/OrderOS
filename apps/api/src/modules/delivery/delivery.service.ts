import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import type { DeliveryProvider, DeliveryStatus, Order, Restaurant } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { storefrontBaseUrl } from '../../common/tenant-url';
import { RedisService } from '../../common/redis/redis.service';
import { AuditService } from '../../common/audit/audit.service';
import { toE164 } from '../../common/phone';
import { NotificationsService } from '../notifications/notifications.service';
import { SmsService } from '../notifications/sms.service';
import { OrdersService } from '../orders/orders.service';
import { StorageService } from '../storage/storage.service';
import { GeocodingService, distanceMeters, type GeoPoint, type GeocodableAddress } from './geocoding.service';
import { CourierRouter } from './courier.router';
import {
  CourierDeclinedError,
  type CourierDelivery,
  type CourierStatus,
} from './courier.interface';
import { mapUberStatus } from './uber.courier';
import { mapDoorDashStatus } from './doordash.client';
import { RoutingService } from './routing.service';
import {
  UberClient,
  UberClientError,
  UberServerError,
  type UberDelivery,
  type UberDeliveryStatus,
} from './uber.client';

const MAX_ATTEMPTS = 5;

/**
 * Backoff between dispatch attempts: 30s, 60s, 2m, 4m, 8m.
 *
 * Capped at 8 minutes on purpose. This is a bag of hot food sitting on the pass,
 * not a background job — an hour-long backoff is indistinguishable from having
 * dropped the order entirely, except that the food is now cold as well as late.
 *
 * Exported and pure so the schedule can be tested without a database, a Redis or an
 * Uber account.
 */
export function retryDelayMs(attemptCount: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attemptCount - 1), 8 * 60_000);
}

/**
 * How many DIFFERENT couriers we will chase before a human must take over.
 *
 * Not infinite, on purpose. If four couriers in a row have failed to deliver this
 * order, the problem is not luck — it is the address, the area, or the time of
 * night — and a fifth automated attempt is just a slower way of not feeding
 * someone who has already paid.
 */
const MAX_REDISPATCHES = 4;

/**
 * A short handoff code the courier reads aloud and staff match against the bag.
 *
 * Four characters from an alphabet with the ambiguous glyphs removed — no O/0, no
 * I/1/L, no S/5. This is read off a phone screen, in a loud kitchen, by someone
 * who may not be a native speaker, and then typed on a greasy tablet. "0" vs "O"
 * is not a theoretical collision here; it's Tuesday.
 *
 * ~33^4 ≈ 1.2M combinations, but it doesn't need to be unguessable — it needs to
 * be un-confusable between the two or three bags physically on the pass right now.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRTUVWXYZ';

function generatePickupCode(): string {
  const bytes = randomBytes(4);
  return Array.from(bytes)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join('');
}

/** Evenly downsample a route's [lat,lng] points to at most `n`, for the driver simulator. */
function sampleRoute(route: Array<[number, number]>, n: number): Array<[number, number]> {
  if (route.length <= n || n < 2) return route;
  const out: Array<[number, number]> = [];
  for (let k = 0; k < n; k++) {
    out.push(route[Math.round((k * (route.length - 1)) / (n - 1))]);
  }
  return out;
}

/**
 * Turn a `data:image/jpeg;base64,...` URL from the driver's phone into a Buffer the
 * storage layer can take. Only the image types the store already allows get through;
 * anything else is rejected here rather than deep inside the upload.
 */
function decodeImageDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/i.exec(dataUrl.trim());
  if (!match) {
    throw new BadRequestException('Proof photo must be a JPEG, PNG or WebP image');
  }
  return { mimeType: match[1].toLowerCase(), buffer: Buffer.from(match[2], 'base64') };
}

/** Great-circle distance in metres. Used to tell courier movement from GPS jitter. */
function haversineMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(h));
}

@Injectable()
export class DeliveryService {
  private readonly logger = new Logger(DeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly uber: UberClient,
    // Makes deliveryRadiusMeters real: without coordinates it was decorative.
    private readonly geocoding: GeocodingService,
    private readonly couriers: CourierRouter,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    // Escalation wakes a human up by text.
    private readonly sms: SmsService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
    // Proof-of-delivery photos from the driver's phone land in the same store as
    // every other tenant image.
    private readonly storage: StorageService,
    // Used by the test-driver simulator to move a fake courier along the real route.
    private readonly routing: RoutingService,
    // Builds the customer tracking URL the simulator hands back so staff can watch.
    private readonly config: ConfigService,
  ) {}

  /**
   * Price a delivery before the customer commits. Called from checkout so the
   * cart can show a real fee rather than a guess.
   *
   * Note the fee we quote the CUSTOMER is the restaurant's configured
   * deliveryFeeCents — a flat, predictable number. The Uber quote is what the
   * restaurant PAYS. We surface both to the owner in analytics; the gap is their
   * margin (or their subsidy).
   */
  async getQuote(
    restaurantId: string,
    dropoff: { street: string; city: string; state: string; postalCode: string; country: string; latitude?: number; longitude?: number },
    orderValueCents: number,
  ) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    if (this.couriers.enabledFor(restaurant).length === 0) {
      // The restaurant switched a courier on in Settings, but this deployment has no
      // credentials for it (never configured, revoked, wrong region) -- OUR gap, not
      // the customer's. Every other branch below hands back a specific, actionable
      // reason instead of failing checkout outright; this one used to throw a bare
      // 400, which the storefront's generic error handler flattened into "we could
      // not check delivery for that address" with no way for anyone to tell why.
      this.logger.warn(
        `${restaurant.slug} has a courier toggled on with no working credentials -- quote unavailable`,
      );
      return {
        deliverable: false as const,
        reason: 'Delivery is temporarily unavailable. Please try pickup, or call us.',
      };
    }

    // The restaurant's own radius, checked before we spend an Uber call on it.
    const radius = await this.geocoding.checkRadius(restaurant, dropoff);

    if (radius && !radius.withinRadius) {
      const km = (radius.distanceMeters / 1000).toFixed(1);
      const limitKm = (restaurant.deliveryRadiusMeters / 1000).toFixed(1);

      this.logger.log(
        `Rejected an out-of-range delivery for ${restaurant.slug}: ${km}km vs a ${limitKm}km limit`,
      );

      // Not an error — a plain, useful answer. And it tells them how far out they
      // are, so "we're 200m over" turns into a phone call rather than a shrug.
      return {
        deliverable: false as const,
        reason: `That address is ${km}km away — outside our ${limitKm}km delivery range. Choose pickup, or call us.`,
        outOfRange: true as const,
        distanceMeters: radius.distanceMeters,
        limitMeters: restaurant.deliveryRadiusMeters,
      };
    }

    /**
     * Quote every courier the restaurant has switched on and take the cheapest.
     *
     * With both Uber and DoorDash enabled this is worth real money: courier pricing
     * swings with surge and driver supply, the winner is not knowable in advance, and
     * the gap is routinely a dollar or two — on every single delivery, to a business
     * running on single-digit margins. It is also the failover: one courier having a
     * bad afternoon no longer means a paid order cannot be delivered.
     */
    const { quote, declineReason } = await this.couriers.bestQuote(restaurant, {
      pickup: restaurant,
      dropoff,
      pickupReadyAt: new Date(Date.now() + restaurant.prepTimeMinutes * 60_000),
      orderValueCents,
      // Not yet dispatched, so there is no order id to key on. DoorDash requires an
      // external id even to quote; this one is thrown away unless the quote is taken.
      externalId: `quote_${randomUUID()}`,
    });

    if (!quote) {
      // Nobody will take it. `declineReason` is the sentence a working courier
      // actually gave us ("outside our delivery zone"), which is specific and
      // actionable. Its absence means every courier was BROKEN rather than
      // declining — the customer can't act on that, so they get the neutral line.
      return {
        deliverable: false as const,
        reason:
          declineReason ??
          'We could not arrange a courier to that address right now. Please try pickup, or call us.',
      };
    }

    return {
      quoteId: quote.quoteId,
      /** Which courier won, so dispatch goes back to the one that gave us this price. */
      provider: quote.provider,
      /** What the restaurant will be charged by the courier. */
      courierFeeCents: quote.feeCents,
      /**
       * What the customer pays -- the courier's REAL quote, passed through exactly.
       * restaurant.deliveryFeeCents only prices SELF delivery now (see the branch
       * above this method): there is no live quote for a restaurant's own driver to
       * pass through. A real courier's fee used to be discarded here in favour of
       * the restaurant's flat setting, which meant the restaurant silently absorbed
       * the gap on every order where distance/surge pushed the real cost above (or
       * let it profit below) that flat number. This makes delivery pricing neutral
       * to the restaurant: application_fee_amount already recovers exactly this
       * same courierFeeCents from their payout, so charging the customer anything
       * else was pure variance with no business reason behind it.
       */
      customerFeeCents: quote.feeCents,
      currency: quote.currency,
      expiresAt: quote.expiresAt,
      dropoffEta: quote.dropoffEta,
      durationMinutes: quote.durationMinutes,
      deliverable: true as const,
    };
  }

  /**
   * Dispatch a courier. Called when the restaurant marks an order READY.
   *
   * Concurrency: guarded by a Redis lock keyed on the order. Two staff members
   * hitting "Ready" simultaneously, or a retry racing the original, must not
   * result in two couriers arriving for one bag of food.
   */
  async createDelivery(restaurantId: string, orderId: string, userId?: string) {
    // No blanket Uber check any more: a restaurant may run DoorDash only. Whether a
    // courier can actually be dispatched is decided per-restaurant in dispatch(),
    // which quotes whatever they have switched on.
    const release = await this.redis.acquireLock(`delivery:${orderId}`, 30);
    if (!release) {
      throw new BadRequestException('A delivery is already being arranged for this order');
    }

    try {
      const order = await this.prisma.order.findFirst({
        where: { id: orderId, restaurantId },
        include: { items: true, delivery: true, restaurant: true, payment: true },
      });
      if (!order) throw new NotFoundException('Order not found');

      if (order.fulfillment !== 'DELIVERY') {
        throw new BadRequestException('This is not a delivery order');
      }
      if (order.payment?.status !== 'PAID') {
        throw new BadRequestException('Cannot dispatch a courier for an unpaid order');
      }
      if (order.delivery?.providerDeliveryId) {
        // Already dispatched. Idempotent: hand back what exists.
        return order.delivery;
      }
      if (!order.deliveryStreet) {
        throw new BadRequestException('This order has no delivery address');
      }

      const delivery = await this.prisma.delivery.upsert({
        where: { orderId },
        create: {
          orderId,
          restaurantId,
          status: 'PENDING',
          // Minted once, on first dispatch. A retry must NOT mint a new code —
          // the bag label is already printed and stuck to the bag.
          pickupCode: generatePickupCode(),
        },
        update: { attemptCount: { increment: 1 }, lastAttemptAt: new Date() },
      });

      try {
        const dispatched = await this.dispatch(order, order.restaurant, delivery.pickupCode);

        const updated = await this.prisma.delivery.update({
          where: { id: delivery.id },
          data: {
            status: 'CREATED',
            // WHICH courier rode. Everything downstream — tracking, cancellation, the
            // watchdog, the webhook — has to know, because a DoorDash delivery id sent
            // to Uber's API is a confusing 404 rather than an error that says what
            // went wrong.
            provider: dispatched.provider,
            providerDeliveryId: dispatched.deliveryId,
            providerQuoteId: dispatched.quoteId,
            trackingUrl: dispatched.trackingUrl,
            feeCents: dispatched.feeCents,
            currency: dispatched.currency,
            pickupEta: dispatched.pickupEta,
            dropoffEta: dispatched.dropoffEta,
            lastError: null,
            // This attempt succeeded — nothing is pending any more. Cleared in the
            // same write that records the courier, so there is no window in which a
            // dispatched delivery is also still queued for dispatch.
            nextRetryAt: null,
            // A RE-dispatch is a fresh courier: wipe any handoff and courier state left
            // by a previous attempt (on a first dispatch these are already null). Without
            // this, a retry inherits the old "handed over" flag and never re-prompts for
            // the pickup code, and the card shows the previous courier's name.
            handedOverAt: null,
            handedOverByUserId: null,
            courierName: null,
            courierPhone: null,
            courierVehicle: null,
            courierLatitude: null,
            courierLongitude: null,
            pickedUpAt: null,
          },
        });

        await this.audit.log({
          restaurantId,
          userId,
          action: 'delivery.created',
          entityType: 'Delivery',
          entityId: updated.id,
          metadata: {
            orderNumber: order.orderNumber,
            provider: dispatched.provider,
            providerDeliveryId: dispatched.deliveryId,
            courierFeeCents: dispatched.feeCents,
          },
        });

        this.logger.log(
          `${dispatched.provider} delivery ${dispatched.deliveryId} created for order ` +
            `${order.orderNumber} (fee ${dispatched.feeCents})`,
        );
        return updated;
      } catch (err) {
        await this.handleDispatchFailure(delivery.id, order, err as Error);
        // A courier decline (bad address/phone, no driver) is something staff can act on
        // -- surface the courier's ACTUAL reason as a 4xx, so a manual "Try Uber again"
        // shows "The parameters of your request were invalid" rather than an opaque 500.
        throw new BadRequestException(
          err instanceof Error ? err.message : 'No courier would take this delivery',
        );
      }
    } finally {
      await release();
    }
  }

  /**
   * Send a courier — the cheapest one that will actually come.
   *
   * Re-quotes at dispatch time rather than reusing the quote from checkout. Those are
   * minutes apart (the customer paid, then the kitchen cooked), and a courier quote is
   * only honoured for a few of them. Re-quoting also means the cheaper courier is
   * chosen against conditions NOW, not against surge pricing that has since passed.
   *
   * Falls down the list on failure: if the cheapest courier rejects the dispatch — an
   * expired quote, a driver shortage in the last thirty seconds — we try the next one
   * rather than stranding an order that has already been paid for and cooked.
   */
  private async dispatch(
    order: Order & { items: Array<{ name: string; quantity: number; totalCents: number }> },
    restaurant: Restaurant,
    pickupCode: string | null,
  ): Promise<CourierDelivery> {
    const dropoff = {
      street: order.deliveryStreet!,
      city: order.deliveryCity!,
      state: order.deliveryState!,
      postalCode: order.deliveryPostalCode!,
      country: order.deliveryCountry ?? restaurant.country,
      latitude: order.deliveryLatitude,
      longitude: order.deliveryLongitude,
    };

    const request = {
      pickup: restaurant,
      dropoff,
      pickupReadyAt: new Date(),
      orderValueCents: order.totalCents,
      // Our order id. Both couriers echo it back on webhooks, which is how an inbound
      // event maps to an order without trusting anything else in the payload. It is
      // also DoorDash's idempotency key: a retried dispatch returns the delivery that
      // already exists instead of sending a SECOND courier to the same bag of food.
      externalId: order.id,
      restaurantName: restaurant.name,
      // Couriers reject anything but E.164 with a 400 — normalise both phones to
      // +<cc><number> so a number typed as "514-555-1234" dispatches instead of
      // erroring. Fall back to the raw value if it's too mangled to normalise (the
      // courier gives the final verdict; better to send something than an empty field).
      restaurantPhone: toE164(restaurant.phone, restaurant.country) ?? restaurant.phone,
      customerName: order.customerName,
      customerPhone: toE164(order.customerPhone, restaurant.country) ?? order.customerPhone,
      orderNumber: order.orderNumber,
      dropoffNotes: order.deliveryNotes ?? order.notes,
      pickupCode,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity })),
      // The customer's tip was collected at checkout but never reached the courier
      // -- neither adapter forwarded it, so it silently stayed with the platform
      // instead of paying whoever actually carries the food.
      tip: order.tipCents,
    };

    const { quotes, declineReason } = await this.couriers.quoteAll(restaurant, request);

    if (quotes.length === 0) {
      // Every courier said no. This order is paid for and cooked, so this is not a
      // quiet failure — handleDispatchFailure escalates it to a human, who calls the
      // customer. See the caller.
      throw new CourierDeclinedError(
        declineReason ?? 'No courier would accept this delivery',
        'UBER',
      );
    }

    let lastError: Error | null = null;

    for (const quote of quotes) {
      try {
        const courier = this.couriers.forProvider(quote.provider);
        return await courier.createDelivery({ ...request, quoteId: quote.quoteId });
      } catch (err) {
        lastError = err as Error;
        this.logger.warn(
          `${quote.provider} rejected the dispatch for order ${order.orderNumber} ` +
            `(${lastError.message}). Trying the next courier.`,
        );
      }
    }

    throw lastError ?? new Error('Every courier rejected the dispatch');
  }

  /**
   * A dispatch failed. Decide whether it's worth trying again.
   *
   * 4xx (undeliverable address, order too big) is permanent — retrying just
   * delays telling the restaurant that they need to call the customer. 5xx and
   * timeouts go on the queue with exponential backoff.
   */
  private async handleDispatchFailure(
    deliveryId: string,
    order: Order,
    err: Error,
  ): Promise<void> {
    // By the time a dispatch error reaches here it's been TRANSLATED (see
    // uber.courier.translate): a 4xx becomes CourierDeclinedError, a 5xx/network/outage
    // becomes CourierUnavailableError. The old check was `err instanceof UberClientError`,
    // which is the RAW pre-translation type and therefore never matched — so a permanent
    // 400 (bad phone, undeliverable address) was queued for retry and re-failed
    // MAX_ATTEMPTS times, showing staff "retrying automatically" for something retrying
    // can never fix. A decline is permanent; only "courier unavailable" is worth a retry.
    const isPermanent = err instanceof CourierDeclinedError;

    const delivery = await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        lastError: err.message.slice(0, 500),
        lastAttemptAt: new Date(),
        attemptCount: { increment: 1 },
        ...(isPermanent ? { status: 'FAILED' as DeliveryStatus } : {}),
      },
    });

    await this.audit.log({
      restaurantId: order.restaurantId,
      action: 'delivery.dispatch_failed',
      entityType: 'Delivery',
      entityId: deliveryId,
      metadata: {
        orderNumber: order.orderNumber,
        error: err.message,
        permanent: isPermanent,
        attempt: delivery.attemptCount,
      },
    });

    if (isPermanent) {
      this.logger.error(
        `Uber permanently rejected delivery for order ${order.orderNumber}: ${err.message}`,
      );
      return;
    }

    if (delivery.attemptCount >= MAX_ATTEMPTS) {
      await this.prisma.delivery.update({
        where: { id: deliveryId },
        // nextRetryAt cleared: nothing should pick this up again.
        data: { status: 'FAILED', nextRetryAt: null },
      });
      this.logger.error(
        `Giving up on Uber delivery for order ${order.orderNumber} after ${MAX_ATTEMPTS} attempts`,
      );
      return;
    }

    const delayMs = retryDelayMs(delivery.attemptCount);

    // The queue IS this column. Written to Postgres, next to the delivery it
    // belongs to — not to a Redis set whose eviction would silently lose the only
    // record that this order still needs a courier.
    await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: { nextRetryAt: new Date(Date.now() + delayMs) },
    });

    this.logger.warn(
      `Queued delivery ${deliveryId} for retry ${delivery.attemptCount + 1}/${MAX_ATTEMPTS} in ${delayMs / 1000}s`,
    );
  }

  /**
   * Drain the retry queue. Driven by a cron in DeliveryRetryProcessor.
   *
   * The Redis lock inside createDelivery() is what makes this safe to run on
   * every API instance at once: they'll all pop the same id, but only one wins
   * the lock and actually dispatches.
   */
  async processRetryQueue(): Promise<{ processed: number; succeeded: number }> {
    // Nothing to dispatch TO. Checked here rather than per-order so an unconfigured
    // deployment doesn't spin the queue pointlessly on every tick.
    if (!this.couriers.anyConfigured) return { processed: 0, succeeded: 0 };

    const now = new Date();

    const due = await this.prisma.delivery.findMany({
      where: {
        nextRetryAt: { lte: now },
        // Belt and braces. These should all be impossible with nextRetryAt set, but
        // "should be impossible" is how you dispatch a second courier for an order
        // that already has one.
        providerDeliveryId: null,
        status: { notIn: ['FAILED', 'CANCELLED', 'DELIVERED'] },
        order: { status: { not: 'CANCELLED' } },
      },
      select: { id: true, restaurantId: true, orderId: true },
      orderBy: { nextRetryAt: 'asc' },
      take: 20,
    });

    if (due.length === 0) return { processed: 0, succeeded: 0 };

    let processed = 0;
    let succeeded = 0;

    for (const delivery of due) {
      /**
       * CLAIM the row before touching Uber.
       *
       * `updateMany` with `nextRetryAt` still in the WHERE is a compare-and-set: two
       * API instances draining at the same second both see the row, both try to
       * claim it, and exactly one gets count === 1. The loser skips.
       *
       * Postgres does this atomically, which is the property the Redis `zrem` used
       * to provide. Without it, every added API instance multiplies the couriers
       * dispatched — and each one is a real driver, arriving at a real restaurant,
       * charged to a real card.
       */
      const claim = await this.prisma.delivery.updateMany({
        where: { id: delivery.id, nextRetryAt: { lte: now } },
        data: { nextRetryAt: null },
      });
      if (claim.count === 0) continue;

      processed++;

      try {
        await this.createDelivery(delivery.restaurantId, delivery.orderId);
        succeeded++;
        this.logger.log(`Retry succeeded for delivery ${delivery.id}`);
      } catch (err) {
        // createDelivery already recorded the failure and re-scheduled if it should.
        this.logger.warn(`Retry failed for delivery ${delivery.id}: ${(err as Error).message}`);
      }
    }

    return { processed, succeeded };
  }

  async cancelDelivery(restaurantId: string, orderId: string, userId?: string) {
    const delivery = await this.prisma.delivery.findFirst({
      where: { orderId, restaurantId },
      include: { order: true },
    });
    if (!delivery) throw new NotFoundException('No delivery found for this order');

    if (delivery.status === 'DELIVERED') {
      throw new BadRequestException('This delivery has already been completed');
    }
    if (delivery.status === 'CANCELLED') return delivery;

    if (delivery.providerDeliveryId) {
      try {
        // Cancel against whoever we actually dispatched to. Handing a DoorDash
        // delivery id to Uber's API is a 404 that reads like the delivery never
        // existed — and would leave a real courier riding to a customer with a bag
        // of food we believe we cancelled.
        await this.couriers.forProvider(delivery.provider).cancelDelivery(delivery.providerDeliveryId);
      } catch (err) {
        // The courier may refuse if they already have the food. Surface that honestly
        // rather than marking it cancelled in our DB while a driver is still en route
        // with the customer's dinner.
        if (err instanceof CourierDeclinedError) {
          throw new BadRequestException(
            `${delivery.provider} will not cancel this delivery: ${err.message}`,
          );
        }
        throw err;
      }
    }

    // Make sure a queued retry doesn't resurrect a cancelled delivery.
    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { nextRetryAt: null },
    });

    const updated = await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'delivery.cancelled',
      entityType: 'Delivery',
      entityId: delivery.id,
      metadata: { orderNumber: delivery.order.orderNumber },
    });

    return updated;
  }

  // --- Webhooks -------------------------------------------------------------

  /**
   * Handle an Uber delivery webhook. The signature is verified by the controller
   * before this runs.
   *
   * Idempotent via WebhookEvent, and — importantly — order-tolerant: Uber can
   * deliver `delivered` before `dropoff` if the first attempt timed out. We
   * therefore never assert the previous state, we just apply the new one, and we
   * skip transitions the order state machine considers illegal rather than
   * throwing (which would make Uber retry forever).
   */
  async handleWebhook(payload: {
    delivery_id?: string;
    status?: UberDeliveryStatus;
    kind?: string;
    data?: Record<string, unknown>;
    id?: string;
  }): Promise<{ handled: boolean }> {
    const eventId = payload.id ?? `${payload.delivery_id}:${payload.status}:${Date.now()}`;

    const existing = await this.prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: 'uber', eventId } },
    });
    if (existing?.processedAt) return { handled: false };

    const record = await this.prisma.webhookEvent.upsert({
      where: { provider_eventId: { provider: 'uber', eventId } },
      create: {
        provider: 'uber',
        eventId,
        eventType: payload.kind ?? payload.status ?? 'unknown',
        payload: payload as object,
        attempts: 1,
      },
      update: { attempts: { increment: 1 } },
    });

    try {
      const providerDeliveryId = payload.delivery_id ?? (payload.data?.id as string | undefined);
      if (!providerDeliveryId) {
        this.logger.warn('Uber webhook with no delivery_id — ignoring');
        await this.prisma.webhookEvent.update({
          where: { id: record.id },
          data: { processedAt: new Date() },
        });
        return { handled: false };
      }

      const delivery = await this.prisma.delivery.findUnique({
        where: { providerDeliveryId },
        include: { order: { include: { restaurant: true } } },
      });
      if (!delivery) {
        // Not ours (or a test event from Uber's dashboard). Ack it so they stop.
        this.logger.warn(`Uber webhook for unknown delivery ${providerDeliveryId}`);
        await this.prisma.webhookEvent.update({
          where: { id: record.id },
          data: { processedAt: new Date() },
        });
        return { handled: false };
      }

      const data = (payload.data ?? {}) as Partial<UberDelivery>;
      const uberStatus = (payload.status ?? data.status) as UberDeliveryStatus | undefined;
      if (!uberStatus) {
        await this.prisma.webhookEvent.update({
          where: { id: record.id },
          data: { processedAt: new Date() },
        });
        return { handled: false };
      }

      // Flatten Uber's vocabulary at the edge, so everything downstream is
      // provider-neutral. See applyDeliveryUpdate.
      await this.applyDeliveryUpdate(delivery, 'UBER', mapUberStatus(uberStatus), {
        trackingUrl: data.tracking_url,
        dropoffEta: data.dropoff_eta ? new Date(data.dropoff_eta) : null,
        courier: data.courier
          ? {
              name: data.courier.name ?? null,
              phone: data.courier.phone_number ?? null,
              vehicle: data.courier.vehicle_type ?? null,
              latitude: data.courier.location?.lat ?? null,
              longitude: data.courier.location?.lng ?? null,
            }
          : null,
      });

      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: { processedAt: new Date(), error: null },
      });
      return { handled: true };
    } catch (err) {
      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: { error: (err as Error).message },
      });
      throw err;
    }
  }

  /**
   * DoorDash Drive's webhook.
   *
   * Same shape of job as the Uber one — dedupe, find the delivery, apply the update —
   * but DoorDash agrees with Uber on no field names whatsoever, so the parsing is
   * separate and the state machine below is shared.
   *
   * Drive does not send a stable event id, so we synthesise one from the delivery and
   * its status. That is exactly the dedupe key we want: DoorDash retries the SAME
   * status transition, and re-applying "picked_up" twice would re-notify the customer.
   * Two genuinely different transitions hash differently and both get through.
   */
  async handleDoorDashWebhook(payload: Record<string, unknown>): Promise<{ handled: boolean }> {
    const externalId = payload.external_delivery_id as string | undefined;
    const rawStatus = (payload.delivery_status ?? payload.event_name) as string | undefined;

    if (!externalId || !rawStatus) {
      this.logger.warn('DoorDash webhook with no delivery id or status — ignoring');
      return { handled: false };
    }

    const eventId = `${externalId}:${rawStatus}`;

    const record = await this.prisma.webhookEvent.upsert({
      where: { provider_eventId: { provider: 'doordash', eventId } },
      create: {
        provider: 'doordash',
        eventId,
        eventType: rawStatus,
        payload: payload as object,
        attempts: 1,
      },
      update: { attempts: { increment: 1 } },
    });

    // Already applied. Ack and stop — replaying it would re-text the customer.
    if (record.processedAt) return { handled: false };

    try {
      const delivery = await this.prisma.delivery.findUnique({
        where: { providerDeliveryId: externalId },
        include: { order: { include: { restaurant: true } } },
      });

      if (!delivery) {
        // Not ours, or a test event from DoorDash's dashboard. Ack it so they stop.
        this.logger.warn(`DoorDash webhook for unknown delivery ${externalId}`);
        await this.prisma.webhookEvent.update({
          where: { id: record.id },
          data: { processedAt: new Date() },
        });
        return { handled: false };
      }

      const dasher = payload.dasher_name as string | undefined;
      const location = payload.dasher_location as { lat: number; lng: number } | undefined;

      await this.applyDeliveryUpdate(delivery, 'DOORDASH', mapDoorDashStatus(rawStatus), {
        trackingUrl: payload.tracking_url as string | undefined,
        dropoffEta: payload.dropoff_time_estimated
          ? new Date(payload.dropoff_time_estimated as string)
          : null,
        courier: dasher
          ? {
              name: dasher,
              phone: (payload.dasher_phone_number as string | undefined) ?? null,
              vehicle: (payload.dasher_vehicle_make as string | undefined) ?? null,
              latitude: location?.lat ?? null,
              longitude: location?.lng ?? null,
            }
          : null,
      });

      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: { processedAt: new Date(), error: null },
      });
      return { handled: true };
    } catch (err) {
      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: { error: (err as Error).message },
      });
      throw err;
    }
  }

  /**
   * One courier lifecycle event, applied to our own state.
   *
   * Provider-NEUTRAL by design. Uber and DoorDash disagree about almost everything on
   * the wire, but by the time an event reaches here it has been flattened to a
   * CourierStatus by the adapter that received it. That matters more than it looks:
   * this method also drives order transitions, customer notifications, and the
   * automatic hunt for a replacement courier. Any of those living on the Uber side of
   * the fence would mean a DoorDash delivery silently never notifying the customer and
   * never being re-dispatched when it fell through — which is the exact failure of a
   * paid order sitting at CREATED forever while the food goes nowhere.
   */
  private async applyDeliveryUpdate(
    delivery: { id: string; status: DeliveryStatus; trackingUrl: string | null; order: Order & { restaurant: Restaurant } },
    provider: DeliveryProvider,
    courierStatus: CourierStatus,
    data: {
      trackingUrl?: string | null;
      dropoffEta?: Date | null;
      courier?: CourierDelivery['courier'];
    },
  ): Promise<void> {
    const status = this.mapCourierStatus(courierStatus);
    const courier = data.courier;
    const now = new Date();

    const updated = await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status,
        ...(data.trackingUrl ? { trackingUrl: data.trackingUrl } : {}),
        ...(courier
          ? {
              courierName: courier.name ?? undefined,
              courierPhone: courier.phone ?? undefined,
              courierVehicle: courier.vehicle ?? undefined,
              courierLatitude: courier.latitude ?? undefined,
              courierLongitude: courier.longitude ?? undefined,
            }
          : {}),
        ...(data.dropoffEta ? { dropoffEta: data.dropoffEta } : {}),
        ...(courierStatus === 'PICKED_UP' ? { pickedUpAt: now } : {}),
        ...(courierStatus === 'DELIVERED' ? { deliveredAt: now } : {}),
        ...(courierStatus === 'CANCELLED' ? { cancelledAt: now } : {}),
      },
    });

    // Breadcrumb the courier's position so the customer's map can draw the route
    // the driver actually took, rather than teleporting a pin around.
    await this.recordCourierPing(
      delivery.id,
      courier?.latitude != null && courier.longitude != null
        ? { lat: courier.latitude, lng: courier.longitude }
        : undefined,
    );

    const order = delivery.order;
    const restaurant = order.restaurant;

    // Mirror the courier's lifecycle onto the order's own status. If the transition is
    // illegal (a late webhook for an order the restaurant already cancelled), skip it
    // quietly — throwing would make the courier retry the webhook forever.
    const targetOrderStatus =
      courierStatus === 'COURIER_ASSIGNED'
        ? 'DRIVER_ASSIGNED'
        : courierStatus === 'PICKED_UP'
          ? 'OUT_FOR_DELIVERY'
          : courierStatus === 'DELIVERED'
            ? 'DELIVERED'
            : null;

    if (targetOrderStatus) {
      try {
        // The notification engine already knows how to say "Marcus is picking up your
        // order, follow him live" — it reads the courier's name and the tracking URL
        // from the Delivery row we just updated. So we do NOT suppress the
        // notification here; a second bespoke send would double-text the customer.
        await this.orders.transition(order.restaurantId, order.id, targetOrderStatus, {
          source: provider.toLowerCase(),
          note: `${provider}: ${courierStatus}`,
        });
      } catch (err) {
        this.logger.warn(
          `Ignoring ${provider} status ${courierStatus} for order ${order.orderNumber}: ${(err as Error).message}`,
        );
      }
    }

    /**
     * The courier is gone, and the customer still has no food.
     *
     * `canceled` means Uber or the driver dropped it — not that the ORDER is
     * cancelled. The customer has paid, the food is bagged, and nobody is coming.
     * Doing nothing here would leave the order silently stranded forever, which is
     * the single worst thing this system could do.
     *
     * So we immediately go and find another courier. Automatically, without anyone
     * noticing, as many times as it takes — up to a cap, after which a human must
     * take over (see escalate()).
     */
    if (courierStatus === 'CANCELLED' && order.status !== 'CANCELLED') {
      this.logger.warn(
        `${provider} CANCELLED the courier for order ${order.orderNumber} — finding another one`,
      );
      // Note this can now cross providers: an Uber cancellation re-quotes BOTH
      // couriers, so the replacement may well be a DoorDash rider. That is the point.
      await this.redispatch(delivery.id, `${provider} cancelled the courier`);
    }

    // The courier gave up entirely: they couldn't deliver and the food is coming back.
    // A retry might genuinely work (bad address typo, customer now home), so we try —
    // but this is also the case most likely to need a human.
    if (courierStatus === 'FAILED') {
      this.logger.error(
        `${provider} RETURNED order ${order.orderNumber} — food is coming back to the restaurant`,
      );
      await this.audit.log({
        restaurantId: order.restaurantId,
        action: 'delivery.returned',
        entityType: 'Delivery',
        entityId: delivery.id,
        metadata: { orderNumber: order.orderNumber, provider },
      });
      await this.redispatch(delivery.id, `${provider} returned the order undelivered`);
    }
  }

  /** CourierStatus -> our own DeliveryStatus. */
  private mapCourierStatus(status: CourierStatus): DeliveryStatus {
    const map: Record<CourierStatus, DeliveryStatus> = {
      PENDING: 'PENDING',
      CREATED: 'CREATED',
      COURIER_ASSIGNED: 'PICKUP_ENROUTE',
      PICKED_UP: 'DROPOFF_ENROUTE',
      DELIVERED: 'DELIVERED',
      CANCELLED: 'CANCELLED',
      FAILED: 'FAILED',
    };
    return map[status] ?? 'CREATED';
  }

  /**
   * Find another courier for an order whose last one fell through.
   *
   * Clears the Uber identifiers (that delivery is dead) and puts the order back on
   * the dispatch queue with a fresh attempt. The customer sees "finding a driver"
   * again rather than a frozen tracker; the restaurant sees it on the board.
   *
   * After MAX_REDISPATCHES, we stop asking a service that keeps saying no and
   * escalate to a human — because at that point the truthful state is "this order
   * needs a person", and pretending otherwise just means cold food and silence.
   */
  private async redispatch(deliveryId: string, reason: string): Promise<void> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { order: { include: { restaurant: true } } },
    });
    if (!delivery) return;

    // The order is done or dead — nothing to re-dispatch.
    if (['DELIVERED', 'COMPLETED', 'CANCELLED'].includes(delivery.order.status)) return;
    if (delivery.provider === 'SELF') return; // their own driver; not ours to re-send

    if (delivery.redispatchCount >= MAX_REDISPATCHES) {
      await this.escalate(
        deliveryId,
        `${reason}. We tried ${MAX_REDISPATCHES} couriers and none completed the delivery.`,
      );
      return;
    }

    await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        status: 'PENDING',
        // The old Uber delivery is dead. Null the ids so a fresh one can be created
        // — and so createDelivery's "already dispatched" idempotency check doesn't
        // see a stale id and refuse to try again.
        providerDeliveryId: null,
        providerQuoteId: null,
        trackingUrl: null,
        courierName: null,
        courierPhone: null,
        courierVehicle: null,
        redispatchCount: { increment: 1 },
        lastError: reason,
        // Straight back on the queue — due immediately. The retry processor picks
        // it up within 30 seconds. Written in the SAME statement that clears the
        // dead courier, so there is no instant in which this order has neither a
        // courier nor a pending retry: that gap is a lost dinner.
        nextRetryAt: new Date(),
        // Note we deliberately KEEP the pickupCode: the bag label is already
        // printed and stuck to the bag. A new code would mean a courier reading
        // out something that doesn't match what staff are looking at.
      },
    });

    await this.audit.log({
      restaurantId: delivery.restaurantId,
      action: 'delivery.redispatched',
      entityType: 'Delivery',
      entityId: deliveryId,
      metadata: {
        orderNumber: delivery.order.orderNumber,
        reason,
        attempt: delivery.redispatchCount + 1,
      },
    });

    this.logger.log(
      `Re-dispatching order ${delivery.order.orderNumber} (courier ${delivery.redispatchCount + 1} of ${MAX_REDISPATCHES})`,
    );
  }

  /**
   * Stop automating. Get a human.
   *
   * This is NOT a failure state — the order is still live and still owed. It means
   * the machine has exhausted what it can honestly do, and continuing to retry
   * silently would just mean nobody ever finds out that a paying customer is
   * sitting there with no dinner.
   *
   * So we shout: the restaurant gets an SMS, the order card turns red, and the
   * delivery stays visible until someone resolves it (their own driver, a refund,
   * a phone call). Silence is the only truly unacceptable outcome.
   */
  async escalate(deliveryId: string, reason: string): Promise<void> {
    const delivery = await this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: { order: { include: { restaurant: true } } },
    });
    if (!delivery || delivery.escalatedAt) return; // already shouted; don't shout twice

    await this.prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        status: 'FAILED',
        escalatedAt: new Date(),
        escalationReason: reason,
        // Off the queue — it is now a person's job, not a cron's.
        nextRetryAt: null,
      },
    });

    const order = delivery.order;
    const restaurant = order.restaurant;

    await this.audit.log({
      restaurantId: delivery.restaurantId,
      action: 'delivery.escalated',
      entityType: 'Delivery',
      entityId: deliveryId,
      metadata: { orderNumber: order.orderNumber, reason },
    });

    this.logger.error(
      `ESCALATED order ${order.orderNumber}: ${reason}. A human must deliver this order.`,
    );

    // Wake somebody up. This is the whole point of escalating.
    void this.sms
      .send(
        restaurant.notifyPhone ?? restaurant.phone,
        `ACTION NEEDED — order #${order.orderNumber}: we cannot get a courier (${reason}). ` +
          `The customer has paid and is waiting. Deliver it yourself or call them on ${order.customerPhone}.`,
      )
      .catch(() => {
        // The SMS failing does not un-escalate the order. It is still red on the
        // board, and the watchdog will keep it there.
      });
  }

  /**
   * Append a courier position to the trail — but only if they've actually moved.
   *
   * Uber sends location on every webhook, and a driver waiting at a red light or
   * standing in the restaurant would otherwise generate hundreds of identical rows
   * per delivery. ~15 metres is roughly the noise floor of a phone GPS, so anything
   * smaller is jitter, not movement.
   */
  private async recordCourierPing(
    deliveryId: string,
    location: { lat: number; lng: number } | undefined,
  ): Promise<void> {
    if (!location?.lat || !location?.lng) return;

    try {
      const last = await this.prisma.courierPing.findFirst({
        where: { deliveryId },
        orderBy: { createdAt: 'desc' },
        select: { latitude: true, longitude: true },
      });

      if (last && haversineMeters(last, { latitude: location.lat, longitude: location.lng }) < 15) {
        return; // hasn't meaningfully moved
      }

      await this.prisma.courierPing.create({
        data: { deliveryId, latitude: location.lat, longitude: location.lng },
      });
    } catch (err) {
      // The trail is a nice-to-have. Never fail a delivery update over it.
      this.logger.warn(`Could not record courier ping: ${(err as Error).message}`);
    }
  }

  /**
   * TEST tool: animate a fake courier along the real route so staff can watch the
   * customer tracking map move — a car gliding from the restaurant to the door, the
   * route drawing, the map following — without a real driver's phone or a live Uber
   * delivery. Staff-triggered; steps the delivery's courier position every ~2.5s.
   */
  async simulateDelivery(
    restaurantId: string,
    orderId: string,
  ): Promise<{ ok: true; steps: number; trackingUrl: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: {
        delivery: { select: { id: true } },
        restaurant: { select: { latitude: true, longitude: true, country: true, slug: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillment !== 'DELIVERY') {
      throw new BadRequestException('Only a delivery order can be simulated');
    }
    const from =
      order.restaurant.latitude != null && order.restaurant.longitude != null
        ? { latitude: order.restaurant.latitude, longitude: order.restaurant.longitude }
        : null;
    const to =
      order.deliveryLatitude != null && order.deliveryLongitude != null
        ? { latitude: order.deliveryLatitude, longitude: order.deliveryLongitude }
        : null;
    if (!from || !to) {
      throw new BadRequestException(
        'Need both the restaurant and the delivery address geocoded to simulate a driver.',
      );
    }

    // A delivery record to hang the courier position on. Create a self one if there isn't
    // one yet, so the tracking page has something to show.
    let deliveryId = order.delivery?.id;
    if (!deliveryId) {
      const created = await this.prisma.delivery.create({
        data: {
          orderId,
          restaurantId,
          provider: 'SELF',
          status: 'CREATED',
          pickupCode: generatePickupCode(),
          driverName: 'Test driver (simulated)',
        },
        select: { id: true },
      });
      deliveryId = created.id;
    }
    const id = deliveryId;

    // Fresh run: wipe the previous breadcrumb trail and the last courier fix. Without
    // this every re-run overlays another restaurant->door pass, and the map turns into
    // a spider-web of grey lines from all the past runs (exactly what was reported).
    await this.prisma.courierPing.deleteMany({ where: { deliveryId: id } }).catch(() => {});
    await this.prisma.delivery
      .update({ where: { id }, data: { courierLatitude: null, courierLongitude: null } })
      .catch(() => {});

    const route =
      (await this.routing.route(from, to, { country: order.restaurant.country })) ?? [
        [from.latitude, from.longitude],
        [to.latitude, to.longitude],
      ];
    // Sample densely enough that the recorded trail hugs the road instead of cutting
    // corners between a handful of far-apart points. recordCourierPing drops anything
    // under 15m of the last, so on a short hop these naturally thin out.
    const steps = sampleRoute(route, 40);

    // Move it in the background; return immediately so the button doesn't hang.
    let i = 0;
    const tick = async () => {
      if (i >= steps.length) return;
      const [lat, lng] = steps[i++];
      await this.prisma.delivery
        .update({ where: { id }, data: { courierLatitude: lat, courierLongitude: lng } })
        .catch(() => {});
      await this.recordCourierPing(id, { lat, lng });
      if (i < steps.length) setTimeout(() => void tick(), 2000);
    };
    void tick();

    // The customer tracking page — the same link an Uber SMS would carry — so staff
    // can open it straight from the POS and watch the simulated car move.
    const trackingUrl = `${storefrontBaseUrl(this.config, order.restaurant.slug)}/track/${order.trackingToken}`;

    this.logger.log(`Simulating a driver for order ${orderId} over ${steps.length} steps`);
    return { ok: true, steps: steps.length, trackingUrl };
  }

  /**
   * The restaurant will deliver this one themselves.
   *
   * No Uber, no courier fee, no dispatch — just their own driver and the order's
   * status moved by hand. This exists because forcing a restaurant that owns a
   * moped to pay Uber for a delivery two streets away is how you lose the
   * restaurant.
   *
   * The order still transitions through the same state machine, so the customer
   * gets exactly the same notifications and tracking page. They never need to know
   * or care who is carrying their food — only that it's coming.
   */
  async createSelfDelivery(
    restaurantId: string,
    orderId: string,
    driver: { name?: string; phone?: string },
    userId?: string,
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: { payment: true, delivery: true },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.fulfillment !== 'DELIVERY') {
      throw new BadRequestException('This is not a delivery order');
    }
    if (order.payment?.status !== 'PAID') {
      throw new BadRequestException('Cannot dispatch an unpaid order');
    }
    if (order.delivery?.providerDeliveryId) {
      throw new BadRequestException(
        'An Uber courier is already on the way for this order. Cancel that first.',
      );
    }

    // A fresh capability token every time a self-delivery is (re)assigned. Long and
    // random: it's the only thing standing between a stranger and the ability to post
    // fake GPS for this order, so it must be unguessable, and rotating it on reassign
    // means a link handed to yesterday's driver can't move today's order.
    const driverShareToken = randomBytes(24).toString('base64url');

    const delivery = await this.prisma.delivery.upsert({
      where: { orderId },
      create: {
        orderId,
        restaurantId,
        provider: 'SELF',
        status: 'CREATED',
        driverName: driver.name,
        driverPhone: driver.phone,
        driverShareToken,
      },
      update: {
        provider: 'SELF',
        status: 'CREATED',
        driverName: driver.name,
        driverPhone: driver.phone,
        driverShareToken,
        // A queued Uber retry must not resurrect a delivery the restaurant has
        // decided to handle themselves — that sends a courier to collect food their
        // own driver already took. Cleared in the same write that claims it as SELF.
        nextRetryAt: null,
      },
    });

    await this.orders.transition(restaurantId, orderId, 'DRIVER_ASSIGNED', {
      userId,
      source: 'restaurant',
      note: driver.name ? `Own driver: ${driver.name}` : 'Delivering with own driver',
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'delivery.self_assigned',
      entityType: 'Delivery',
      entityId: delivery.id,
      metadata: { orderNumber: order.orderNumber, driverName: driver.name },
    });

    this.logger.log(`Order ${order.orderNumber} assigned to own driver (${driver.name ?? 'unnamed'})`);
    return delivery;
  }

  /**
   * Staff move their own driver along. Uber does this for us via webhooks; for a
   * self-delivery there is nobody to send one, so the buttons on the order card
   * are the source of truth.
   */
  async markSelfDeliveryStatus(
    restaurantId: string,
    orderId: string,
    status: 'OUT_FOR_DELIVERY' | 'DELIVERED',
    userId?: string,
  ) {
    const delivery = await this.prisma.delivery.findFirst({
      where: { orderId, restaurantId },
    });
    if (!delivery) throw new NotFoundException('No delivery for this order');

    if (delivery.provider !== 'SELF') {
      throw new BadRequestException(
        'This is an Uber delivery — its status comes from Uber, not from here',
      );
    }

    await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status: status === 'DELIVERED' ? 'DELIVERED' : 'DROPOFF_ENROUTE',
        ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : { pickedUpAt: new Date() }),
      },
    });

    // Same state machine, same notifications: the customer gets their "on its way"
    // text and their delivery thank-you exactly as they would with an Uber courier.
    return this.orders.transition(restaurantId, orderId, status, {
      userId,
      source: 'restaurant',
    });
  }

  /**
   * Staff confirm they handed the bag to the right courier.
   *
   * The flow at the pass: a driver walks up, staff ask "what's your pickup code?",
   * the driver reads it off their app, staff type it in. If it doesn't match, the
   * bag stays on the counter — which is the entire point.
   *
   * Case-insensitive and whitespace-tolerant, because this is being typed on a
   * greasy tablet by someone holding a hot bag, not by a QA engineer.
   *
   * Deliberately NOT a hard gate on the order's state machine: if the code system
   * fails (Uber didn't show it, the driver's app crashed), staff must still be able
   * to give the courier the food. So a mismatch REFUSES and explains, but staff can
   * force it through with `override` — and we record who did, and why. A safety
   * control that can't be overridden is a safety control that gets worked around.
   */
  async verifyHandoff(
    restaurantId: string,
    orderId: string,
    input: { code?: string; override?: boolean; overrideReason?: string },
    userId?: string,
  ) {
    const delivery = await this.prisma.delivery.findFirst({
      where: { orderId, restaurantId },
      include: { order: { select: { orderNumber: true } } },
    });
    if (!delivery) throw new NotFoundException('No delivery for this order');

    if (delivery.handedOverAt) {
      // Idempotent: two staff both tapping "handed over" is not an error.
      return { verified: true, alreadyHandedOver: true, delivery };
    }

    const expected = delivery.pickupCode?.trim().toUpperCase();
    const given = input.code?.trim().toUpperCase().replace(/\s+/g, '');

    const matches = Boolean(expected && given && expected === given);

    if (!matches && !input.override) {
      // Do NOT reveal the expected code in the error. Staff can see it on their own
      // screen; echoing it here would let anyone who can hit this endpoint learn the
      // code by guessing once.
      throw new BadRequestException({
        statusCode: 400,
        error: 'PickupCodeMismatch',
        message: given
          ? "That code doesn't match this order. Check the driver is collecting the right one — do not hand over the bag."
          : 'Enter the code the driver reads out from their app.',
      });
    }

    const updated = await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: { handedOverAt: new Date(), handedOverByUserId: userId },
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: input.override && !matches ? 'delivery.handoff_overridden' : 'delivery.handed_over',
      entityType: 'Delivery',
      entityId: delivery.id,
      metadata: {
        orderNumber: delivery.order.orderNumber,
        courierName: delivery.courierName,
        codeMatched: matches,
        // The reason an override happened is the only useful thing about it.
        overrideReason: input.override && !matches ? (input.overrideReason ?? 'not given') : undefined,
      },
    });

    if (input.override && !matches) {
      this.logger.warn(
        `Handoff OVERRIDDEN for order ${delivery.order.orderNumber} — code did not match. Reason: ${input.overrideReason ?? 'none given'}`,
      );
    } else {
      this.logger.log(
        `Order ${delivery.order.orderNumber} handed to ${delivery.courierName ?? 'courier'} (code verified)`,
      );
    }

    return { verified: matches, alreadyHandedOver: false, delivery: updated };
  }

  /** The courier's route so far, for the live map. Oldest first. */
  async getCourierTrail(deliveryId: string) {
    return this.prisma.courierPing.findMany({
      where: { deliveryId },
      orderBy: { createdAt: 'asc' },
      select: { latitude: true, longitude: true, createdAt: true },
      // A long delivery through a city can accumulate a lot of points; the map
      // only needs enough to draw a convincing line.
      take: 200,
    });
  }

  // --- Own-driver live location (the /d/<token> page) ------------------------
  //
  // A self-delivering restaurant's own rider has no courier API sending us GPS. So
  // instead the rider opens a capability link on their phone and the browser streams
  // location straight into the same courierLatitude/Longitude + CourierPing rows a
  // real courier's webhooks write — which is all the customer's map ever reads. No
  // app, no key, no third party.

  private async findByShareToken(token: string) {
    const delivery = await this.prisma.delivery.findUnique({
      where: { driverShareToken: token },
      include: {
        order: {
          select: {
            orderNumber: true,
            customerName: true,
            fulfillment: true,
            deliveryStreet: true,
            deliveryCity: true,
            deliveryState: true,
            deliveryPostalCode: true,
            deliveryLatitude: true,
            deliveryLongitude: true,
            deliveryNotes: true,
          },
        },
        restaurant: { select: { id: true, name: true, phone: true } },
      },
    });
    // A deliberately vague 404 — the token IS the credential, so a precise "expired"
    // vs "wrong" would help someone probing for a valid one.
    if (!delivery) throw new NotFoundException('This driver link is not valid');
    return delivery;
  }

  /** What the driver's phone shows: where to go, for which order, and its state. */
  async getDriverContext(token: string) {
    const d = await this.findByShareToken(token);
    const o = d.order;
    const dropoff = [o.deliveryStreet, o.deliveryCity, o.deliveryState, o.deliveryPostalCode]
      .filter(Boolean)
      .join(', ');

    return {
      orderNumber: o.orderNumber,
      restaurantName: d.restaurant.name,
      customerName: o.customerName,
      dropoffAddress: dropoff || null,
      dropoffNotes: o.deliveryNotes ?? null,
      dropoffLatitude: o.deliveryLatitude,
      dropoffLongitude: o.deliveryLongitude,
      status: d.status,
      // Terminal deliveries stop accepting pings; the page uses this to shut sharing
      // off and say "delivered" rather than silently posting into the void.
      finished: d.status === 'DELIVERED' || d.status === 'CANCELLED' || d.status === 'FAILED',
    };
  }

  /** A location fix from the driver's phone. The hot path — kept tiny. */
  async recordDriverPing(token: string, location: { lat: number; lng: number }) {
    const d = await this.prisma.delivery.findUnique({
      where: { driverShareToken: token },
      select: { id: true, status: true },
    });
    if (!d) throw new NotFoundException('This driver link is not valid');

    // Don't keep tracking a delivery that's over — a phone left with the page open
    // would otherwise ping for hours after the food was dropped.
    if (d.status === 'DELIVERED' || d.status === 'CANCELLED' || d.status === 'FAILED') {
      return { accepted: false as const };
    }

    await this.prisma.delivery.update({
      where: { id: d.id },
      data: { courierLatitude: location.lat, courierLongitude: location.lng },
    });
    // Reuses the 15m-dedupe helper, so a rider idling at a light doesn't spam rows.
    await this.recordCourierPing(d.id, location);
    return { accepted: true as const };
  }

  /**
   * The driver advances their own order from their phone (picked up / delivered),
   * optionally attaching a proof-of-delivery photo taken at handover.
   *
   * The photo is stored and stamped on the delivery BEFORE the status transition, so
   * that by the time the "delivered" notification fires the proof is already on the
   * record — a customer disputing "I never got it" is answered by an image with a
   * timestamp, not by the driver's word.
   */
  async advanceDriverStatus(
    token: string,
    status: 'OUT_FOR_DELIVERY' | 'DELIVERED',
    photoBase64?: string,
  ) {
    const d = await this.findByShareToken(token);

    if (photoBase64 && status === 'DELIVERED') {
      try {
        const { buffer, mimeType } = decodeImageDataUrl(photoBase64);
        const { url } = await this.storage.upload(
          buffer,
          mimeType,
          `restaurants/${d.restaurant.id}/proof-of-delivery`,
        );
        await this.prisma.delivery.update({
          where: { id: d.id },
          data: { proofOfDeliveryUrl: url },
        });
      } catch (err) {
        // A failed photo upload must NOT block marking the food delivered — the
        // handover already happened in the real world. Log and carry on.
        this.logger.warn(`Proof-of-delivery photo upload failed: ${(err as Error).message}`);
      }
    }

    return this.markSelfDeliveryStatus(d.restaurant.id, d.orderId, status);
  }

  private mapStatus(uberStatus: UberDeliveryStatus): DeliveryStatus {
    const map: Record<UberDeliveryStatus, DeliveryStatus> = {
      pending: 'CREATED',
      pickup: 'PICKUP_ENROUTE',
      pickup_complete: 'DROPOFF_ENROUTE',
      dropoff: 'DROPOFF_ENROUTE',
      delivered: 'DELIVERED',
      canceled: 'CANCELLED',
      returned: 'FAILED',
    };
    return map[uberStatus] ?? 'CREATED';
  }

  /** Uber's error strings are written for engineers. Rewrite them for a customer. */
  private humanizeUberError(err: UberClientError): string {
    const message = err.message.toLowerCase();
    if (message.includes('address') || message.includes('undeliverable')) {
      return 'We could not find a courier for that address — please check it, or choose pickup';
    }
    if (message.includes('too far') || message.includes('distance')) {
      return 'That address is outside the delivery range';
    }
    if (message.includes('closed') || message.includes('hours')) {
      return 'Delivery is not available at this time';
    }
    return 'Delivery is not available for this order right now';
  }

  // --- Dashboard reads ------------------------------------------------------

  async getByOrder(restaurantId: string, orderId: string) {
    const delivery = await this.prisma.delivery.findFirst({ where: { orderId, restaurantId } });
    if (!delivery) throw new NotFoundException('No delivery for this order');
    return delivery;
  }

  /**
   * Poll the courier directly. A manual "refresh" button for when a webhook was
   * missed — asked of whichever courier actually has the food.
   */
  async refreshStatus(restaurantId: string, orderId: string) {
    const delivery = await this.getByOrder(restaurantId, orderId);
    if (!delivery.providerDeliveryId) return delivery;
    // The restaurant's own driver has no API to poll. Their status is whatever staff
    // last told us it was, which is already in the row.
    if (delivery.provider === 'SELF') return delivery;

    const current = await this.couriers
      .forProvider(delivery.provider)
      .getDelivery(delivery.providerDeliveryId);

    const full = await this.prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: { order: { include: { restaurant: true } } },
    });
    if (!full) throw new NotFoundException('Delivery not found');

    await this.applyDeliveryUpdate(full, current.provider, current.status, {
      trackingUrl: current.trackingUrl,
      dropoffEta: current.dropoffEta,
      courier: current.courier,
    });
    return this.prisma.delivery.findUnique({ where: { id: delivery.id } });
  }
}
