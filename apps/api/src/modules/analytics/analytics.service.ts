import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export type Period = '7d' | '30d' | '90d';

const PERIOD_DAYS: Record<Period, number> = { '7d': 7, '30d': 30, '90d': 90 };

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Headline numbers, with a comparison against the immediately preceding window
   * of the same length — "revenue is £4,200" means nothing on its own; "£4,200,
   * up 12% on the previous 30 days" is a decision.
   *
   * Revenue counts PAID orders only, and is net of refunds. Counting gross would
   * flatter the number and make the dashboard a liar.
   */
  async getOverview(restaurantId: string, period: Period = '30d') {
    const days = PERIOD_DAYS[period];
    const now = new Date();
    const start = new Date(now.getTime() - days * 86_400_000);
    const previousStart = new Date(start.getTime() - days * 86_400_000);

    const [current, previous] = await Promise.all([
      this.aggregate(restaurantId, start, now),
      this.aggregate(restaurantId, previousStart, start),
    ]);

    return {
      period,
      revenueCents: current.revenueCents,
      orderCount: current.orderCount,
      averageOrderCents: current.averageOrderCents,
      newCustomers: current.newCustomers,
      refundedCents: current.refundedCents,
      changes: {
        revenue: this.percentChange(current.revenueCents, previous.revenueCents),
        orders: this.percentChange(current.orderCount, previous.orderCount),
        averageOrder: this.percentChange(current.averageOrderCents, previous.averageOrderCents),
      },
    };
  }

  private async aggregate(restaurantId: string, from: Date, to: Date) {
    const [orderAgg, refundAgg, newCustomers] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          restaurantId,
          createdAt: { gte: from, lt: to },
          payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        },
        _sum: { totalCents: true },
        _count: true,
        _avg: { totalCents: true },
      }),
      this.prisma.payment.aggregate({
        where: { restaurantId, createdAt: { gte: from, lt: to } },
        _sum: { refundedAmountCents: true },
      }),
      this.prisma.customer.count({
        where: { restaurantId, createdAt: { gte: from, lt: to } },
      }),
    ]);

    const gross = orderAgg._sum.totalCents ?? 0;
    const refunded = refundAgg._sum.refundedAmountCents ?? 0;

    return {
      revenueCents: gross - refunded,
      refundedCents: refunded,
      orderCount: orderAgg._count,
      averageOrderCents: Math.round(orderAgg._avg.totalCents ?? 0),
      newCustomers,
    };
  }

  /** Daily revenue and order count. Feeds the dashboard's line chart. */
  async getRevenueSeries(restaurantId: string, period: Period = '30d') {
    const days = PERIOD_DAYS[period];
    const start = new Date(Date.now() - days * 86_400_000);
    start.setHours(0, 0, 0, 0);

    // Raw SQL: Prisma's groupBy can't bucket a timestamp by day, and pulling
    // every order into Node to group it there would fall over on a busy tenant.
    const rows = await this.prisma.$queryRaw<
      Array<{ day: Date; revenue_cents: bigint; order_count: bigint }>
    >`
      SELECT
        date_trunc('day', o."createdAt") AS day,
        COALESCE(SUM(o."totalCents"), 0)::bigint AS revenue_cents,
        COUNT(*)::bigint AS order_count
      FROM orders o
      JOIN payments p ON p."orderId" = o.id
      WHERE o."restaurantId" = ${restaurantId}
        AND o."createdAt" >= ${start}
        AND p.status IN ('PAID', 'PARTIALLY_REFUNDED')
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const byDay = new Map(
      rows.map((r) => [
        r.day.toISOString().slice(0, 10),
        { revenueCents: Number(r.revenue_cents), orderCount: Number(r.order_count) },
      ]),
    );

    // Fill the gaps. A chart that silently skips zero-revenue days makes a slow
    // week look like a busy one.
    const series: Array<{ date: string; revenueCents: number; orderCount: number }> = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const entry = byDay.get(date);
      series.push({
        date,
        revenueCents: entry?.revenueCents ?? 0,
        orderCount: entry?.orderCount ?? 0,
      });
    }
    return series;
  }

  async getTopProducts(restaurantId: string, period: Period = '30d', limit = 10) {
    const start = new Date(Date.now() - PERIOD_DAYS[period] * 86_400_000);

    const rows = await this.prisma.orderItem.groupBy({
      by: ['productId', 'name'],
      where: {
        order: {
          restaurantId,
          createdAt: { gte: start },
          payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        },
      },
      _sum: { quantity: true, totalCents: true },
      orderBy: { _sum: { totalCents: 'desc' } },
      take: limit,
    });

    return rows.map((r) => ({
      productId: r.productId,
      name: r.name,
      unitsSold: r._sum.quantity ?? 0,
      revenueCents: r._sum.totalCents ?? 0,
    }));
  }

  /** Where orders come from, and what each channel is worth. */
  async getFulfillmentBreakdown(restaurantId: string, period: Period = '30d') {
    const start = new Date(Date.now() - PERIOD_DAYS[period] * 86_400_000);

    const rows = await this.prisma.order.groupBy({
      by: ['fulfillment'],
      where: {
        restaurantId,
        createdAt: { gte: start },
        payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      },
      _count: true,
      _sum: { totalCents: true },
    });

    const total = rows.reduce((sum, r) => sum + r._count, 0);
    return rows.map((r) => ({
      fulfillment: r.fulfillment,
      orderCount: r._count,
      revenueCents: r._sum.totalCents ?? 0,
      share: total > 0 ? Math.round((r._count / total) * 100) : 0,
    }));
  }

  /**
   * The delivery P&L the restaurant can't get from Uber's own dashboard: what we
   * charged customers for delivery, against what Uber actually billed. A negative
   * margin here means every delivery order loses money.
   */
  async getDeliveryEconomics(restaurantId: string, period: Period = '30d') {
    const start = new Date(Date.now() - PERIOD_DAYS[period] * 86_400_000);

    const deliveries = await this.prisma.delivery.findMany({
      where: {
        restaurantId,
        createdAt: { gte: start },
        status: { in: ['DELIVERED', 'DROPOFF_ENROUTE', 'PICKUP_ENROUTE', 'CREATED'] },
      },
      select: { feeCents: true, order: { select: { deliveryFeeCents: true } } },
    });

    const uberCostCents = deliveries.reduce((sum, d) => sum + (d.feeCents ?? 0), 0);
    const collectedCents = deliveries.reduce((sum, d) => sum + d.order.deliveryFeeCents, 0);

    return {
      deliveryCount: deliveries.length,
      /** What customers paid us for delivery. */
      collectedCents,
      /** What Uber charged us. */
      uberCostCents,
      /** Positive = delivery is profitable. Negative = you're subsidising it. */
      marginCents: collectedCents - uberCostCents,
      averageUberFeeCents:
        deliveries.length > 0 ? Math.round(uberCostCents / deliveries.length) : 0,
    };
  }

  /** Order volume by hour of day, for staffing decisions. */
  async getHourlyHeatmap(restaurantId: string, period: Period = '30d') {
    const start = new Date(Date.now() - PERIOD_DAYS[period] * 86_400_000);

    const rows = await this.prisma.$queryRaw<Array<{ hour: number; order_count: bigint }>>`
      SELECT
        EXTRACT(HOUR FROM o."createdAt")::int AS hour,
        COUNT(*)::bigint AS order_count
      FROM orders o
      JOIN payments p ON p."orderId" = o.id
      WHERE o."restaurantId" = ${restaurantId}
        AND o."createdAt" >= ${start}
        AND p.status IN ('PAID', 'PARTIALLY_REFUNDED')
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const byHour = new Map(rows.map((r) => [r.hour, Number(r.order_count)]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      orderCount: byHour.get(hour) ?? 0,
    }));
  }

  private percentChange(current: number, previous: number): number | null {
    // No baseline means no percentage. Returning 100% (or Infinity) for "went
    // from 0 to something" is a lie the UI would render as a green arrow.
    if (previous === 0) return null;
    return Math.round(((current - previous) / previous) * 100);
  }
}
