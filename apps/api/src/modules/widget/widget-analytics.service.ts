import { Injectable, Logger } from '@nestjs/common';
import type { WidgetEventType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class WidgetAnalyticsService {
  private readonly logger = new Logger(WidgetAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a funnel event.
   *
   * Deduplicated by the @@unique([integrationId, sessionId, type]) index: a
   * customer who opens the widget five times in one visit is one OPEN. Without
   * that, "conversion rate" would be orders divided by an inflated denominator
   * and would drift downward the more engaged your customers were — precisely
   * backwards.
   *
   * Never throws. A failed analytics write must not break someone's checkout.
   */
  async record(params: {
    integrationId: string;
    restaurantId: string;
    type: WidgetEventType;
    sessionId: string;
    origin?: string;
    orderId?: string;
  }): Promise<void> {
    try {
      await this.prisma.widgetEvent.upsert({
        where: {
          integrationId_sessionId_type: {
            integrationId: params.integrationId,
            sessionId: params.sessionId,
            type: params.type,
          },
        },
        create: {
          integrationId: params.integrationId,
          restaurantId: params.restaurantId,
          type: params.type,
          sessionId: params.sessionId,
          origin: params.origin,
          orderId: params.orderId,
        },
        // Already seen this session do this. Keep the first timestamp; only fill
        // in the orderId, which the earlier event couldn't have known.
        update: params.orderId ? { orderId: params.orderId } : {},
      });
    } catch (err) {
      this.logger.warn(`Widget event dropped: ${(err as Error).message}`);
    }
  }

  /**
   * The funnel, per website, with real revenue attached.
   *
   * Revenue is read from Order/Payment — NOT from the event table. An
   * ORDER_CREATED event means an order row exists, which is not the same as
   * money arriving: the customer may still abandon Stripe. Counting events as
   * revenue would overstate every number on this page.
   */
  async getFunnel(restaurantId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);

    const integrations = await this.prisma.websiteIntegration.findMany({
      where: { restaurantId },
      select: { id: true, name: true, domain: true, installedAt: true, lastSeenAt: true },
    });

    if (integrations.length === 0) return [];

    const [events, revenue] = await Promise.all([
      this.prisma.widgetEvent.groupBy({
        by: ['integrationId', 'type'],
        where: { restaurantId, createdAt: { gte: since } },
        _count: true,
      }),
      // Paid orders only, net of refunds.
      this.prisma.order.groupBy({
        by: ['websiteIntegrationId'],
        where: {
          restaurantId,
          createdAt: { gte: since },
          websiteIntegrationId: { not: null },
          payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        },
        _sum: { totalCents: true },
        _count: true,
      }),
    ]);

    const countOf = (integrationId: string, type: WidgetEventType) =>
      events.find((e) => e.integrationId === integrationId && e.type === type)?._count ?? 0;

    return integrations.map((integration) => {
      const views = countOf(integration.id, 'VIEW');
      const opens = countOf(integration.id, 'OPEN');
      const addToCart = countOf(integration.id, 'ADD_TO_CART');
      const checkouts = countOf(integration.id, 'CHECKOUT_START');

      const money = revenue.find((r) => r.websiteIntegrationId === integration.id);
      const paidOrders = money?._count ?? 0;
      const revenueCents = money?._sum.totalCents ?? 0;

      return {
        integrationId: integration.id,
        name: integration.name,
        domain: integration.domain,
        installedAt: integration.installedAt,
        lastSeenAt: integration.lastSeenAt,

        views,
        opens,
        addToCart,
        checkouts,
        paidOrders,
        revenueCents,

        /**
         * Views -> paid orders. The number the owner actually cares about: of
         * everyone who saw the button on my website, how many bought food?
         * Null rather than 0 when nobody has seen it — "0%" on a site with no
         * traffic reads as failure when it's really an absence of data.
         */
        conversionRate: views > 0 ? Number(((paidOrders / views) * 100).toFixed(1)) : null,
        /** How many people who opened the widget went on to pay. */
        openToOrderRate: opens > 0 ? Number(((paidOrders / opens) * 100).toFixed(1)) : null,
        /** Started checkout but never paid. High = a payment problem, not a menu problem. */
        abandonedCheckouts: Math.max(0, checkouts - paidOrders),
        averageOrderCents: paidOrders > 0 ? Math.round(revenueCents / paidOrders) : 0,
      };
    });
  }
}
