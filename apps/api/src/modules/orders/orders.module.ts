import { Module, forwardRef } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { PaymentsModule } from '../payments/payments.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  // Circular by design: Orders dispatches couriers, Delivery drives the order
  // state machine from Uber webhooks. forwardRef is the sanctioned way to say so.
  //
  // PaymentsModule (one-way, no cycle: payments -> subscriptions -> notifications,
  // never back to orders) lets the counter POS mint a Stripe payment link for a
  // phone order — same orders.create + createCheckoutSession pair the storefront uses.
  imports: [forwardRef(() => DeliveryModule), PromotionsModule, PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
