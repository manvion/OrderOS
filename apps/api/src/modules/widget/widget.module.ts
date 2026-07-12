import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { MenuModule } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { WidgetAdminController } from './widget-admin.controller';
import { WidgetAnalyticsService } from './widget-analytics.service';
import { WidgetPublicController } from './widget-public.controller';
import { WidgetService } from './widget.service';
import { WidgetTenantGuard } from './widget-tenant.guard';

@Module({
  imports: [RestaurantsModule, MenuModule, OrdersModule, PaymentsModule, DeliveryModule],
  controllers: [WidgetPublicController, WidgetAdminController],
  providers: [WidgetService, WidgetAnalyticsService, WidgetTenantGuard],
  // Exported: main.ts asks WidgetService whether an Origin is registered, from
  // inside the CORS callback — which runs before routing, and therefore before
  // any guard could answer the question.
  exports: [WidgetService],
})
export class WidgetModule {}
