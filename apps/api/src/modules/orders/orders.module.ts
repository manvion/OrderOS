import { Module, forwardRef } from '@nestjs/common';
import { DeliveryModule } from '../delivery/delivery.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  // Circular by design: Orders dispatches couriers, Delivery drives the order
  // state machine from Uber webhooks. forwardRef is the sanctioned way to say so.
  imports: [forwardRef(() => DeliveryModule), PromotionsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
