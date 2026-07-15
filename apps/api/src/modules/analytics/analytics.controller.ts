import { BadRequestException, Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Roles, TenantId } from '../../common/auth/decorators';
import { AnalyticsService, type Period } from './analytics.service';

/** `from`/`to` are inclusive-start, exclusive-end day boundaries in the caller's
 *  own timezone-naive sense -- the dashboard sends midnight-to-midnight local
 *  dates and the DB comparison is on `createdAt`, which is UTC; good enough for
 *  a report an owner reads once a day, not close enough for a bank reconciliation. */
function parseDateRange(from?: string, to?: string): { from: Date; to: Date } {
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  if (!fromDate || !toDate || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new BadRequestException('from and to must be valid dates');
  }
  if (fromDate >= toDate) throw new BadRequestException('from must be before to');
  return { from: fromDate, to: toDate };
}

/** MANAGER+ only: revenue is not something every line cook needs to see. */
@ApiTags('analytics')
@Controller('analytics')
@UseGuards(ClerkAuthGuard)
@Roles('MANAGER')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@TenantId() restaurantId: string, @Query('period') period: Period = '30d') {
    return this.analytics.getOverview(restaurantId, period);
  }

  @Get('revenue')
  revenue(@TenantId() restaurantId: string, @Query('period') period: Period = '30d') {
    return this.analytics.getRevenueSeries(restaurantId, period);
  }

  @Get('top-products')
  topProducts(@TenantId() restaurantId: string, @Query('period') period: Period = '30d') {
    return this.analytics.getTopProducts(restaurantId, period);
  }

  @Get('fulfillment')
  fulfillment(@TenantId() restaurantId: string, @Query('period') period: Period = '30d') {
    return this.analytics.getFulfillmentBreakdown(restaurantId, period);
  }

  @Get('delivery-economics')
  deliveryEconomics(@TenantId() restaurantId: string, @Query('period') period: Period = '30d') {
    return this.analytics.getDeliveryEconomics(restaurantId, period);
  }

  @Get('hourly')
  hourly(@TenantId() restaurantId: string, @Query('period') period: Period = '30d') {
    return this.analytics.getHourlyHeatmap(restaurantId, period);
  }

  @Get('tax-report')
  taxReport(
    @TenantId() restaurantId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = parseDateRange(from, to);
    return this.analytics.getTaxReport(restaurantId, range.from, range.to);
  }

  @Get('tax-report.csv')
  async taxReportCsv(
    @TenantId() restaurantId: string,
    @Res() res: Response,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = parseDateRange(from, to);
    const csv = await this.analytics.getTaxReportCsv(restaurantId, range.from, range.to);
    const name = `tax-report_${range.from.toISOString().slice(0, 10)}_to_${range.to.toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv);
  }
}
