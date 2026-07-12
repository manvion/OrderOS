import { Module, forwardRef } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryRetryProcessor } from './delivery-retry.processor';
import { DeliveryWatchdog } from './delivery-watchdog.processor';
import { DeliveryService } from './delivery.service';
import { GeocodingService } from './geocoding.service';
import { AddressAutocompleteService } from './address-autocomplete.service';
import { CourierRouter } from './courier.router';
import { DoorDashClient } from './doordash.client';
import { UberClient } from './uber.client';
import { UberCourier } from './uber.courier';

@Module({
  // See OrdersModule: the cycle is intentional and both sides declare it.
  imports: [forwardRef(() => OrdersModule)],
  controllers: [DeliveryController],
  providers: [
    UberClient,
    UberCourier,
    DoorDashClient,
    CourierRouter,
    GeocodingService,
    AddressAutocompleteService,
    DeliveryService,
    DeliveryRetryProcessor,
    DeliveryWatchdog,
  ],
  exports: [
    DeliveryService,
    UberClient,
    CourierRouter,
    GeocodingService,
    AddressAutocompleteService,
  ],
})
export class DeliveryModule {}
