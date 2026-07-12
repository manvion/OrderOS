import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaymentsService } from './payments.service';

/**
 * Catches orders where the customer paid but the webhook never arrived.
 *
 * Webhooks are not a guarantee. Stripe retries, but if our API was down, or the
 * event was dropped, or a deploy killed the request mid-flight, an order can sit
 * PENDING forever: the customer has been charged, the kitchen never sees the
 * ticket, and nobody finds out until an angry phone call.
 *
 * That is the worst failure mode in this entire system — we took the money and
 * silently didn't make the food — so it gets a sweeper rather than a hope.
 *
 * Every five minutes we ask STRIPE (the source of truth for money) about any order
 * that has been pending payment for a few minutes, and reconcile.
 */
@Injectable()
export class PaymentReconciliationProcessor {
  private readonly logger = new Logger(PaymentReconciliationProcessor.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const now = Date.now();

      const stuck = await this.prisma.payment.findMany({
        where: {
          status: 'PENDING',
          stripeCheckoutSessionId: { not: null },
          // Give the webhook a fair chance first. Under 3 minutes this is almost
          // always just a customer still typing their card number, and polling
          // Stripe for them would be pointless load.
          createdAt: {
            lt: new Date(now - 3 * 60_000),
            // Checkout sessions expire after 30 minutes and Stripe emits
            // `checkout.session.expired`; beyond a couple of hours there is nothing
            // left to reconcile and we'd just be scanning history forever.
            gt: new Date(now - 3 * 60 * 60_000),
          },
          order: { status: 'PENDING' },
        },
        select: { id: true, stripeCheckoutSessionId: true, order: { select: { orderNumber: true } } },
        take: 50,
      });

      if (stuck.length === 0) return;

      this.logger.log(`Reconciling ${stuck.length} order(s) stuck awaiting payment`);

      let recovered = 0;
      for (const payment of stuck) {
        try {
          const wasRecovered = await this.payments.reconcileCheckoutSession(
            payment.stripeCheckoutSessionId!,
          );
          if (wasRecovered) {
            recovered++;
            this.logger.warn(
              `RECOVERED order ${payment.order.orderNumber} — the customer had paid, but we never received the webhook`,
            );
          }
        } catch (err) {
          this.logger.error(
            `Could not reconcile session ${payment.stripeCheckoutSessionId}: ${(err as Error).message}`,
          );
        }
      }

      if (recovered > 0) {
        this.logger.warn(
          `Reconciliation recovered ${recovered} paid order(s) that webhooks had missed. ` +
            `If this number is not zero regularly, the webhook endpoint needs investigating.`,
        );
      }
    } catch (err) {
      this.logger.error(`Reconciliation sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
