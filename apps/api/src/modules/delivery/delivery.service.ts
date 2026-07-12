import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { DeliveryStatus, Order, Restaurant } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { AuditService } from '../../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SmsService } from '../notifications/sms.service';
import { OrdersService } from '../orders/orders.service';
import { GeocodingService, distanceMeters, type GeoPoint, type GeocodableAddress } from './geocoding.service';
import {
  UberClient,
  UberClientError,
  UberServerError,
  type UberDelivery,
  type UberDeliveryStatus,
} from './uber.client';

/** Redis sorted set: member = deliveryId, score = epoch ms of next attempt. */
export const RETRY_QUEUE_KEY = 'uber:retry_queue';
const MAX_ATTEMPTS = 5;

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
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    // Escalation wakes a human up by text.
    private readonly sms: SmsService,
    @Inject(forwardRef(() => OrdersService))
    private readonly orders: OrdersService,
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
    this.uber.assertConfigured();

    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    if (!restaurant.uberDirectEnabled) {
      throw new BadRequestException('This restaurant does not use Uber Direct');
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

    try {
      const quote = await this.uber.createQuote({
        pickup_address: UberClient.formatAddress(restaurant),
        dropoff_address: UberClient.formatAddress(dropoff),
        pickup_latitude: restaurant.latitude ?? undefined,
        pickup_longitude: restaurant.longitude ?? undefined,
        dropoff_latitude: dropoff.latitude,
        dropoff_longitude: dropoff.longitude,
        pickup_ready_dt: new Date(Date.now() + restaurant.prepTimeMinutes * 60_000).toISOString(),
        manifest_total_value: orderValueCents,
      });

      return {
        quoteId: quote.id,
        /** What the restaurant will be charged by Uber. */
        uberFeeCents: quote.fee,
        /** What the customer pays. Set by the restaurant, not by Uber. */
        customerFeeCents: restaurant.deliveryFeeCents,
        currency: quote.currency,
        expiresAt: quote.expires,
        dropoffEta: quote.dropoff_eta,
        durationMinutes: quote.duration,
        deliverable: true as const,
      };
    } catch (err) {
      // A 4xx here almost always means "we don't deliver to that address" — which
      // is a normal, expected answer, not an error. Tell the customer plainly
      // instead of 500ing the checkout page.
      if (err instanceof UberClientError) {
        this.logger.log(`Uber declined a quote for ${restaurant.slug}: ${err.message}`);
        return {
          deliverable: false as const,
          reason: this.humanizeUberError(err),
        };
      }
      throw err;
    }
  }

  /**
   * Dispatch a courier. Called when the restaurant marks an order READY.
   *
   * Concurrency: guarded by a Redis lock keyed on the order. Two staff members
   * hitting "Ready" simultaneously, or a retry racing the original, must not
   * result in two couriers arriving for one bag of food.
   */
  async createDelivery(restaurantId: string, orderId: string, userId?: string) {
    this.uber.assertConfigured();

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
      if (order.delivery?.uberDeliveryId) {
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
        const uberDelivery = await this.dispatch(order, order.restaurant, delivery.pickupCode);

        const updated = await this.prisma.delivery.update({
          where: { id: delivery.id },
          data: {
            status: 'CREATED',
            uberDeliveryId: uberDelivery.id,
            uberQuoteId: uberDelivery.quote_id,
            trackingUrl: uberDelivery.tracking_url,
            feeCents: uberDelivery.fee,
            currency: uberDelivery.currency,
            pickupEta: uberDelivery.pickup_eta ? new Date(uberDelivery.pickup_eta) : null,
            dropoffEta: uberDelivery.dropoff_eta ? new Date(uberDelivery.dropoff_eta) : null,
            lastError: null,
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
            uberDeliveryId: uberDelivery.id,
            uberFeeCents: uberDelivery.fee,
          },
        });

        // Remove from the retry queue: this attempt succeeded.
        await this.redis.client.zrem(RETRY_QUEUE_KEY, delivery.id);

        this.logger.log(
          `Uber delivery ${uberDelivery.id} created for order ${order.orderNumber} (fee ${uberDelivery.fee})`,
        );
        return updated;
      } catch (err) {
        await this.handleDispatchFailure(delivery.id, order, err as Error);
        throw err;
      }
    } finally {
      await release();
    }
  }

  private async dispatch(
    order: Order & { items: Array<{ name: string; quantity: number; totalCents: number }> },
    restaurant: Restaurant,
    pickupCode: string | null,
  ): Promise<UberDelivery> {
    return this.uber.createDelivery({
      pickup_name: restaurant.name,
      pickup_business_name: restaurant.name,
      pickup_address: UberClient.formatAddress(restaurant),
      pickup_phone_number: restaurant.phone,
      pickup_latitude: restaurant.latitude ?? undefined,
      pickup_longitude: restaurant.longitude ?? undefined,
      // The courier reads these in their driver app when they arrive. Leading with
      // the code is what lets staff say "read me your code" and get an answer.
      pickup_notes: pickupCode
        ? `PICKUP CODE: ${pickupCode} — order #${order.orderNumber}. Staff will ask you for this code.`
        : `Order #${order.orderNumber}`,

      dropoff_name: order.customerName,
      dropoff_address: UberClient.formatAddress({
        street: order.deliveryStreet!,
        city: order.deliveryCity!,
        state: order.deliveryState!,
        postalCode: order.deliveryPostalCode!,
        country: order.deliveryCountry ?? 'US',
      }),
      dropoff_phone_number: order.customerPhone,
      dropoff_latitude: order.deliveryLatitude ?? undefined,
      dropoff_longitude: order.deliveryLongitude ?? undefined,
      dropoff_notes: order.deliveryNotes ?? order.notes ?? undefined,

      manifest_items: order.items.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        size: 'small' as const,
        price: item.totalCents,
      })),
      manifest_total_value: order.totalCents,
      // Shown to the courier as the thing they are collecting. Putting the code
      // here means it appears in their app next to the restaurant's name, which is
      // exactly where they'll be looking when staff ask for it.
      manifest_reference: pickupCode
        ? `${pickupCode} · #${order.orderNumber}`
        : order.orderNumber,

      // Our order id. Uber echoes it on webhooks, which is how we map an inbound
      // event back to an order without trusting anything else in the payload.
      external_id: order.id,
    });
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
    const isPermanent = err instanceof UberClientError;

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
        data: { status: 'FAILED' },
      });
      this.logger.error(
        `Giving up on Uber delivery for order ${order.orderNumber} after ${MAX_ATTEMPTS} attempts`,
      );
      return;
    }

    // Exponential backoff: 30s, 60s, 2m, 4m, 8m — capped so a long Uber outage
    // doesn't leave a bag of food sitting on the pass for an hour.
    const delayMs = Math.min(30_000 * 2 ** (delivery.attemptCount - 1), 8 * 60_000);
    const nextAttemptAt = Date.now() + delayMs;

    await this.redis.client.zadd(RETRY_QUEUE_KEY, nextAttemptAt, deliveryId);
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
    if (!this.uber.isConfigured) return { processed: 0, succeeded: 0 };

    const now = Date.now();
    const due = await this.redis.client.zrangebyscore(RETRY_QUEUE_KEY, 0, now, 'LIMIT', 0, 20);
    if (due.length === 0) return { processed: 0, succeeded: 0 };

    let succeeded = 0;

    for (const deliveryId of due) {
      // Pop it first: if this process dies mid-retry, handleDispatchFailure will
      // re-queue it. Leaving it in the set would let another instance double-fire.
      await this.redis.client.zrem(RETRY_QUEUE_KEY, deliveryId);

      const delivery = await this.prisma.delivery.findUnique({
        where: { id: deliveryId },
        include: { order: true },
      });

      // The order may have been cancelled while the retry was pending. Drop it.
      if (!delivery || delivery.uberDeliveryId || delivery.status === 'FAILED') continue;
      if (delivery.order.status === 'CANCELLED') continue;

      try {
        await this.createDelivery(delivery.restaurantId, delivery.orderId);
        succeeded++;
        this.logger.log(`Retry succeeded for delivery ${deliveryId}`);
      } catch (err) {
        // createDelivery already recorded the failure and re-queued if it should.
        this.logger.warn(`Retry failed for delivery ${deliveryId}: ${(err as Error).message}`);
      }
    }

    return { processed: due.length, succeeded };
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

    if (delivery.uberDeliveryId) {
      try {
        await this.uber.cancelDelivery(delivery.uberDeliveryId);
      } catch (err) {
        // Uber may refuse if the courier already has the food. Surface that
        // honestly rather than marking it cancelled in our DB while a driver is
        // still en route with the customer's dinner.
        if (err instanceof UberClientError) {
          throw new BadRequestException(
            `Uber will not cancel this delivery: ${this.humanizeUberError(err)}`,
          );
        }
        throw err;
      }
    }

    // Make sure a queued retry doesn't resurrect a cancelled delivery.
    await this.redis.client.zrem(RETRY_QUEUE_KEY, delivery.id);

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
      const uberDeliveryId = payload.delivery_id ?? (payload.data?.id as string | undefined);
      if (!uberDeliveryId) {
        this.logger.warn('Uber webhook with no delivery_id — ignoring');
        await this.prisma.webhookEvent.update({
          where: { id: record.id },
          data: { processedAt: new Date() },
        });
        return { handled: false };
      }

      const delivery = await this.prisma.delivery.findUnique({
        where: { uberDeliveryId },
        include: { order: { include: { restaurant: true } } },
      });
      if (!delivery) {
        // Not ours (or a test event from Uber's dashboard). Ack it so they stop.
        this.logger.warn(`Uber webhook for unknown delivery ${uberDeliveryId}`);
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

      await this.applyDeliveryUpdate(delivery, uberStatus, data);

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

  private async applyDeliveryUpdate(
    delivery: { id: string; status: DeliveryStatus; trackingUrl: string | null; order: Order & { restaurant: Restaurant } },
    uberStatus: UberDeliveryStatus,
    data: Partial<UberDelivery>,
  ): Promise<void> {
    const status = this.mapStatus(uberStatus);
    const courier = data.courier;
    const now = new Date();

    const updated = await this.prisma.delivery.update({
      where: { id: delivery.id },
      data: {
        status,
        ...(data.tracking_url ? { trackingUrl: data.tracking_url } : {}),
        ...(courier
          ? {
              courierName: courier.name ?? undefined,
              courierPhone: courier.phone_number ?? undefined,
              courierVehicle: courier.vehicle_type ?? undefined,
              courierLatitude: courier.location?.lat,
              courierLongitude: courier.location?.lng,
            }
          : {}),
        ...(data.dropoff_eta ? { dropoffEta: new Date(data.dropoff_eta) } : {}),
        ...(uberStatus === 'pickup_complete' ? { pickedUpAt: now } : {}),
        ...(uberStatus === 'delivered' ? { deliveredAt: now } : {}),
        ...(uberStatus === 'canceled' ? { cancelledAt: now } : {}),
      },
    });

    // Breadcrumb the courier's position so the customer's map can draw the route
    // the driver actually took, rather than teleporting a pin around.
    await this.recordCourierPing(delivery.id, courier?.location);

    const order = delivery.order;
    const restaurant = order.restaurant;

    // Mirror Uber's courier lifecycle onto the order's own status. If the
    // transition is illegal (a late webhook for an order the restaurant already
    // cancelled), skip it quietly — throwing would make Uber retry forever.
    const targetOrderStatus =
      uberStatus === 'pickup'
        ? 'DRIVER_ASSIGNED'
        : uberStatus === 'pickup_complete' || uberStatus === 'dropoff'
          ? 'OUT_FOR_DELIVERY'
          : uberStatus === 'delivered'
            ? 'DELIVERED'
            : null;

    if (targetOrderStatus) {
      try {
        // The notification engine already knows how to say "Marcus is picking up
        // your order, follow him live" — it reads the courier's name and Uber's
        // tracking URL from the Delivery row we just updated. So we do NOT suppress
        // the notification here; a second bespoke send would double-text the customer.
        await this.orders.transition(order.restaurantId, order.id, targetOrderStatus, {
          source: 'uber',
          note: `Uber: ${uberStatus}`,
        });
      } catch (err) {
        this.logger.warn(
          `Ignoring Uber status ${uberStatus} for order ${order.orderNumber}: ${(err as Error).message}`,
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
    if (uberStatus === 'canceled' && order.status !== 'CANCELLED') {
      this.logger.warn(
        `Uber CANCELLED the courier for order ${order.orderNumber} — finding another one`,
      );
      await this.redispatch(delivery.id, 'Uber cancelled the courier');
    }

    // Uber gave up entirely: the courier couldn't deliver and the food is coming
    // back. A retry might genuinely work (bad address typo, customer now home), so
    // we try — but this is also the case most likely to need a human.
    if (uberStatus === 'returned') {
      this.logger.error(
        `Uber RETURNED order ${order.orderNumber} — food is coming back to the restaurant`,
      );
      await this.audit.log({
        restaurantId: order.restaurantId,
        action: 'delivery.returned',
        entityType: 'Delivery',
        entityId: delivery.id,
        metadata: { orderNumber: order.orderNumber },
      });
      await this.redispatch(delivery.id, 'Uber returned the order undelivered');
    }
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
        uberDeliveryId: null,
        uberQuoteId: null,
        trackingUrl: null,
        courierName: null,
        courierPhone: null,
        courierVehicle: null,
        redispatchCount: { increment: 1 },
        lastError: reason,
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

    // Straight back on the queue. The retry processor picks it up within 30s.
    await this.redis.client.zadd(RETRY_QUEUE_KEY, Date.now(), deliveryId);

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
      data: { status: 'FAILED', escalatedAt: new Date(), escalationReason: reason },
    });

    // Take it off the queue — it is now a person's job, not a cron's.
    await this.redis.client.zrem(RETRY_QUEUE_KEY, deliveryId);

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
    if (order.delivery?.uberDeliveryId) {
      throw new BadRequestException(
        'An Uber courier is already on the way for this order. Cancel that first.',
      );
    }

    const delivery = await this.prisma.delivery.upsert({
      where: { orderId },
      create: {
        orderId,
        restaurantId,
        provider: 'SELF',
        status: 'CREATED',
        driverName: driver.name,
        driverPhone: driver.phone,
      },
      update: {
        provider: 'SELF',
        status: 'CREATED',
        driverName: driver.name,
        driverPhone: driver.phone,
      },
    });

    // Make sure a queued Uber retry can't resurrect a delivery the restaurant has
    // decided to handle themselves — that would send a courier to collect food
    // their own driver already took.
    await this.redis.client.zrem(RETRY_QUEUE_KEY, delivery.id);

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

  /** Poll Uber directly. A manual "refresh" button for when a webhook was missed. */
  async refreshStatus(restaurantId: string, orderId: string) {
    const delivery = await this.getByOrder(restaurantId, orderId);
    if (!delivery.uberDeliveryId) return delivery;

    const uberDelivery = await this.uber.getDelivery(delivery.uberDeliveryId);
    const full = await this.prisma.delivery.findUnique({
      where: { id: delivery.id },
      include: { order: { include: { restaurant: true } } },
    });
    if (!full) throw new NotFoundException('Delivery not found');

    await this.applyDeliveryUpdate(full, uberDelivery.status, uberDelivery);
    return this.prisma.delivery.findUnique({ where: { id: delivery.id } });
  }
}
