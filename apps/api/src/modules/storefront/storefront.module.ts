import { Module } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { MenuModule } from '../menu/menu.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { RestaurantsModule } from '../restaurants/restaurants.module';
import { OptionalCustomerGuard } from '../../common/auth/optional-customer.guard';
import { CustomersModule } from '../customers/customers.module';
import { StorefrontController } from './storefront.controller';

@Module({
  imports: [
    RestaurantsModule,
    MenuModule,
    OrdersModule,
    PaymentsModule,
    PromotionsModule,
    DeliveryModule,
    CustomersModule,
  ],
  providers: [OptionalCustomerGuard],
  controllers: [StorefrontController],
})
export class StorefrontModule {}
