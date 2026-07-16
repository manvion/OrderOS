import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertRestaurantCapability } from '../../common/plan/plan.util';

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
   *
   * `payoutCents` goes a step further: gross minus the platform's commission
   * minus the courier's actual cost -- the two amounts application_fee_amount
   * actually pulls out of the restaurant's Stripe payout on every charge (see
   * PaymentsService). Delivery fee and platform fee were never the restaurant's
   * money to begin with; showing gross revenue next to a smaller real deposit
   * reads as a discrepancy instead of what it is. NOT further adjusted for
   * Stripe's own card-processing fee -- that's a per-charge amount Stripe
   * computes and deducts itself, and Stripe's own payout report is the correct
   * place to see it exactly, not an estimate duplicated here.
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
      payoutCents: current.payoutCents,
      orderCount: current.orderCount,
      averageOrderCents: current.averageOrderCents,
      newCustomers: current.newCustomers,
      refundedCents: current.refundedCents,
      changes: {
        revenue: this.percentChange(current.payoutCents, previous.payoutCents),
        orders: this.percentChange(current.orderCount, previous.orderCount),
        averageOrder: this.percentChange(current.averageOrderCents, previous.averageOrderCents),
      },
    };
  }

  private async aggregate(restaurantId: string, from: Date, to: Date) {
    const [orderAgg, paymentAgg, newCustomers] = await Promise.all([
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
        _sum: { refundedAmountCents: true, platformFeeCents: true, courierCostCents: true },
      }),
      this.prisma.customer.count({
        where: { restaurantId, createdAt: { gte: from, lt: to } },
      }),
    ]);

    const gross = orderAgg._sum.totalCents ?? 0;
    const refunded = paymentAgg._sum.refundedAmountCents ?? 0;
    const platformFee = paymentAgg._sum.platformFeeCents ?? 0;
    const courierCost = paymentAgg._sum.courierCostCents ?? 0;
    const revenue = gross - refunded;

    return {
      revenueCents: revenue,
      payoutCents: Math.max(0, revenue - platformFee - courierCost),
      refundedCents: refunded,
      orderCount: orderAgg._count,
      averageOrderCents: Math.round(orderAgg._avg.totalCents ?? 0),
      newCustomers,
    };
  }

  /**
   * Daily revenue, payout, and order count. Feeds the dashboard's line chart.
   *
   * `revenueCents` was labelled "net of refunds" but the query never actually
   * subtracted them, and never excluded platform commission or courier cost
   * either -- the same gross-vs-actual gap the overview stat had. Both are
   * fixed here the same way: payoutCents is what actually lands in the
   * restaurant's Stripe payout per day.
   */
  async getRevenueSeries(restaurantId: string, period: Period = '30d') {
    const days = PERIOD_DAYS[period];
    const start = new Date(Date.now() - days * 86_400_000);
    start.setHours(0, 0, 0, 0);

    // Raw SQL: Prisma's groupBy can't bucket a timestamp by day, and pulling
    // every order into Node to group it there would fall over on a busy tenant.
    const rows = await this.prisma.$queryRaw<
      Array<{
        day: Date;
        revenue_cents: bigint;
        payout_cents: bigint;
        order_count: bigint;
      }>
    >`
      SELECT
        date_trunc('day', o."createdAt") AS day,
        COALESCE(SUM(o."totalCents" - p."refundedAmountCents"), 0)::bigint AS revenue_cents,
        COALESCE(SUM(
          o."totalCents" - p."refundedAmountCents" - p."platformFeeCents" - COALESCE(p."courierCostCents", 0)
        ), 0)::bigint AS payout_cents,
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
        {
          revenueCents: Number(r.revenue_cents),
          payoutCents: Math.max(0, Number(r.payout_cents)),
          orderCount: Number(r.order_count),
        },
      ]),
    );

    // Fill the gaps. A chart that silently skips zero-revenue days makes a slow
    // week look like a busy one.
    const series: Array<{
      date: string;
      revenueCents: number;
      payoutCents: number;
      orderCount: number;
    }> = [];
    for (let i = 0; i < days; i++) {
      const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
      const entry = byDay.get(date);
      series.push({
        date,
        revenueCents: entry?.revenueCents ?? 0,
        payoutCents: entry?.payoutCents ?? 0,
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

  /**
   * Daily tax totals, broken out by NAME (GST, QST, whatever the restaurant's
   * tax setup calls them) -- an accountant filing a return needs to know which
   * jurisdiction collected what, not just one lump "tax" figure. Every order's
   * taxLines was frozen at checkout with the rates in force that day (see
   * packages/shared/src/tax.ts), so this stays correct even after the
   * restaurant later changes its tax rates.
   */
  async getTaxReport(restaurantId: string, from: Date, to: Date) {
    await assertRestaurantCapability(this.prisma, restaurantId, 'TAX_REPORTS');
    const taxRows = await this.prisma.$queryRaw<
      Array<{ day: Date; tax_name: string; amount_cents: bigint }>
    >`
      SELECT
        date_trunc('day', o."createdAt") AS day,
        COALESCE(tax_line->>'name', 'Tax') AS tax_name,
        SUM((tax_line->>'amountCents')::bigint)::bigint AS amount_cents
      FROM orders o
      JOIN payments p ON p."orderId" = o.id
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o."taxLines", '[]'::jsonb)) AS tax_line
      WHERE o."restaurantId" = ${restaurantId}
        AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
        AND p.status IN ('PAID', 'PARTIALLY_REFUNDED')
      GROUP BY 1, 2
      ORDER BY 1 ASC, 2 ASC
    `;

    const totalRows = await this.prisma.$queryRaw<
      Array<{
        day: Date;
        subtotal_cents: bigint;
        discount_cents: bigint;
        tax_cents: bigint;
        total_cents: bigint;
        order_count: bigint;
      }>
    >`
      SELECT
        date_trunc('day', o."createdAt") AS day,
        COALESCE(SUM(o."subtotalCents"), 0)::bigint AS subtotal_cents,
        COALESCE(SUM(o."discountCents"), 0)::bigint AS discount_cents,
        COALESCE(SUM(o."taxCents"), 0)::bigint AS tax_cents,
        COALESCE(SUM(o."totalCents"), 0)::bigint AS total_cents,
        COUNT(*)::bigint AS order_count
      FROM orders o
      JOIN payments p ON p."orderId" = o.id
      WHERE o."restaurantId" = ${restaurantId}
        AND o."createdAt" >= ${from} AND o."createdAt" < ${to}
        AND p.status IN ('PAID', 'PARTIALLY_REFUNDED')
      GROUP BY 1
      ORDER BY 1 ASC
    `;

    const taxNames = Array.from(new Set(taxRows.map((r) => r.tax_name))).sort();

    const taxByDay = new Map<string, Record<string, number>>();
    for (const r of taxRows) {
      const date = r.day.toISOString().slice(0, 10);
      const entry = taxByDay.get(date) ?? {};
      entry[r.tax_name] = Number(r.amount_cents);
      taxByDay.set(date, entry);
    }

    const daily = totalRows.map((t) => {
      const date = t.day.toISOString().slice(0, 10);
      const taxByName: Record<string, number> = {};
      for (const name of taxNames) taxByName[name] = taxByDay.get(date)?.[name] ?? 0;
      return {
        date,
        subtotalCents: Number(t.subtotal_cents),
        discountCents: Number(t.discount_cents),
        taxCents: Number(t.tax_cents),
        totalCents: Number(t.total_cents),
        orderCount: Number(t.order_count),
        taxByName,
      };
    });

    const summary = daily.reduce(
      (acc, d) => ({
        subtotalCents: acc.subtotalCents + d.subtotalCents,
        discountCents: acc.discountCents + d.discountCents,
        taxCents: acc.taxCents + d.taxCents,
        totalCents: acc.totalCents + d.totalCents,
        orderCount: acc.orderCount + d.orderCount,
      }),
      { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0, orderCount: 0 },
    );

    const taxByName = taxNames.map((name) => ({
      name,
      amountCents: daily.reduce((sum, d) => sum + (d.taxByName[name] ?? 0), 0),
    }));

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      taxNames,
      summary,
      taxByName,
      daily,
    };
  }

  /** Same report, as a spreadsheet -- one row per day, one column per named tax. */
  async getTaxReportCsv(restaurantId: string, from: Date, to: Date): Promise<string> {
    const report = await this.getTaxReport(restaurantId, from, to);
    const dollars = (cents: number) => (cents / 100).toFixed(2);
    const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;

    const header = [
      'Date',
      'Subtotal',
      'Discount',
      ...report.taxNames,
      'Total Tax',
      'Order Total',
      'Orders',
    ];
    const rows = report.daily.map((d) => [
      d.date,
      dollars(d.subtotalCents),
      dollars(d.discountCents),
      ...report.taxNames.map((name) => dollars(d.taxByName[name] ?? 0)),
      dollars(d.taxCents),
      dollars(d.totalCents),
      String(d.orderCount),
    ]);
    const totalRow = [
      'Total',
      dollars(report.summary.subtotalCents),
      dollars(report.summary.discountCents),
      ...report.taxNames.map(
        (name) => dollars(report.taxByName.find((t) => t.name === name)?.amountCents ?? 0),
      ),
      dollars(report.summary.taxCents),
      dollars(report.summary.totalCents),
      String(report.summary.orderCount),
    ];

    return [header, ...rows, totalRow].map((cols) => cols.map(quote).join(',')).join('\n');
  }
}
