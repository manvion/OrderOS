import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Roles, TenantId } from '../../common/auth/decorators';
import { AnalyticsService, type Period } from './analytics.service';

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
}
