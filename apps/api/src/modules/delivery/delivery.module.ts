import { Module, forwardRef } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryRetryProcessor } from './delivery-retry.processor';
import { DeliveryWatchdog } from './delivery-watchdog.processor';
import { DeliveryService } from './delivery.service';
import { GeocodingService } from './geocoding.service';
import { UberClient } from './uber.client';

@Module({
  // See OrdersModule: the cycle is intentional and both sides declare it.
  imports: [forwardRef(() => OrdersModule)],
  controllers: [DeliveryController],
  providers: [UberClient, GeocodingService, DeliveryService, DeliveryRetryProcessor, DeliveryWatchdog],
  exports: [DeliveryService, UberClient, GeocodingService],
})
export class DeliveryModule {}
