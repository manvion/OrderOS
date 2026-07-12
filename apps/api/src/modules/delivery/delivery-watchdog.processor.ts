import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeliveryService } from './delivery.service';

/** No courier assigned this long after the food is ready = something is wrong. */
const NO_COURIER_AFTER_MINUTES = 12;

/** A courier assigned but silent this long = they have probably vanished. */
const COURIER_SILENT_AFTER_MINUTES = 45;

/**
 * The safety net.
 *
 * Every other mechanism in this system is event-driven: a webhook arrives, we act.
 * The watchdog exists for the case where the event NEVER ARRIVES — which is the
 * failure that actually strands orders, because nothing is there to notice.
 *
 * Concretely, it catches:
 *
 *  - Food marked READY, but no delivery record was ever created (the dispatch call
 *    died mid-flight, the process was killed during a deploy).
 *  - A delivery stuck PENDING because it fell off the retry queue (a Redis flush,
 *    an eviction).
 *  - A courier who accepted and then went silent — no webhooks, no movement, no
 *    delivery. Uber's webhook for this sometimes simply doesn't come.
 *
 * The invariant it enforces is the one the whole delivery system rests on:
 *
 *   AN ORDER THAT HAS BEEN PAID FOR IS NEVER SILENTLY ABANDONED.
 *
 * It is either progressing, being re-dispatched, or sitting in front of a human
 * with an alarm attached. There is no fourth state.
 */
@Injectable()
export class DeliveryWatchdog {
  private readonly logger = new Logger(DeliveryWatchdog.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: DeliveryService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.rescueOrdersWithNoDelivery();
      await this.rescueStalledDispatches();
      await this.rescueSilentCouriers();
    } catch (err) {
      this.logger.error(`Watchdog sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * READY, delivery order, paid — and no Delivery row at all.
   *
   * The dispatch never happened. Nothing will ever retry it, because the retry
   * queue only knows about deliveries that exist. Without this sweep the food sits
   * on the pass until a human notices, which on a busy night means never.
   */
  private async rescueOrdersWithNoDelivery(): Promise<void> {
    const cutoff = new Date(Date.now() - NO_COURIER_AFTER_MINUTES * 60_000);

    const stranded = await this.prisma.order.findMany({
      where: {
        status: 'READY',
        fulfillment: 'DELIVERY',
        delivery: null,
        readyAt: { lt: cutoff },
        payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        restaurant: { uberDirectEnabled: true },
      },
      select: { id: true, restaurantId: true, orderNumber: true },
      take: 20,
    });

    for (const order of stranded) {
      this.logger.warn(
        `Order ${order.orderNumber} has been READY for ${NO_COURIER_AFTER_MINUTES}min with no courier requested. Dispatching now.`,
      );
      try {
        await this.delivery.createDelivery(order.restaurantId, order.id);
      } catch (err) {
        // createDelivery already recorded the failure and queued a retry if it
        // was transient. Nothing more to do here.
        this.logger.error(
          `Watchdog dispatch failed for ${order.orderNumber}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * A Delivery row exists, but it has been PENDING for too long and is not on the
   * retry queue — it fell through a crack (Redis restart, a process killed between
   * the DB write and the enqueue).
   */
  private async rescueStalledDispatches(): Promise<void> {
    const cutoff = new Date(Date.now() - NO_COURIER_AFTER_MINUTES * 60_000);

    const stalled = await this.prisma.delivery.findMany({
      where: {
        status: 'PENDING',
        uberDeliveryId: null,
        provider: 'UBER',
        escalatedAt: null,
        createdAt: { lt: cutoff },
        order: { status: { in: ['READY', 'DRIVER_ASSIGNED'] } },
      },
      include: { order: { select: { orderNumber: true } } },
      take: 20,
    });

    for (const delivery of stalled) {
      this.logger.warn(
        `Delivery for order ${delivery.order.orderNumber} has been PENDING for ${NO_COURIER_AFTER_MINUTES}min. Re-queueing.`,
      );
      try {
        await this.delivery.createDelivery(delivery.restaurantId, delivery.orderId);
      } catch {
        // Recorded and queued by createDelivery. If it's exhausted its attempts,
        // escalate rather than looping forever.
        if (delivery.attemptCount >= 5) {
          await this.delivery.escalate(
            delivery.id,
            'We could not reach Uber after repeated attempts',
          );
        }
      }
    }
  }

  /**
   * A courier accepted, then went quiet. No webhooks, no delivery, nothing — for
   * long enough that the food is now cold and the customer has certainly called.
   *
   * We ask Uber directly (rather than trusting the silence), and if the delivery
   * really is dead, we find another courier.
   */
  private async rescueSilentCouriers(): Promise<void> {
    const cutoff = new Date(Date.now() - COURIER_SILENT_AFTER_MINUTES * 60_000);

    const silent = await this.prisma.delivery.findMany({
      where: {
        provider: 'UBER',
        status: { in: ['CREATED', 'PICKUP_ENROUTE', 'DROPOFF_ENROUTE'] },
        uberDeliveryId: { not: null },
        escalatedAt: null,
        updatedAt: { lt: cutoff },
        order: { status: { notIn: ['DELIVERED', 'COMPLETED', 'CANCELLED'] } },
      },
      include: { order: { select: { orderNumber: true } } },
      take: 20,
    });

    for (const delivery of silent) {
      this.logger.warn(
        `No update from Uber on order ${delivery.order.orderNumber} for ${COURIER_SILENT_AFTER_MINUTES}min. Polling them directly.`,
      );

      try {
        // Ask Uber what's actually happening. This applies whatever they say — and
        // if they say `canceled`, applyDeliveryUpdate automatically re-dispatches.
        await this.delivery.refreshStatus(delivery.restaurantId, delivery.orderId);
      } catch (err) {
        this.logger.error(
          `Could not poll Uber for order ${delivery.order.orderNumber}: ${(err as Error).message}`,
        );

        // Uber won't even tell us. That's long enough. A human takes it.
        await this.delivery.escalate(
          delivery.id,
          `No update from the courier for ${COURIER_SILENT_AFTER_MINUTES} minutes and Uber is not responding`,
        );
      }
    }
  }
}
