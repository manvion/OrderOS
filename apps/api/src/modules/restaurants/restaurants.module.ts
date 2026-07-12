import { Module, forwardRef } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { QrModule } from '../qr/qr.module';
import { InvitesController, RestaurantsController } from './restaurants.controller';
import { RestaurantsService } from './restaurants.service';
import { StaffInvitesService } from './staff-invites.service';

@Module({
  // Publishing mints the starter QR codes. No cycle: QrModule doesn't need us.
  imports: [QrModule, forwardRef(() => PaymentsModule)],
  controllers: [RestaurantsController, InvitesController],
  providers: [RestaurantsService, StaffInvitesService],
  exports: [RestaurantsService, StaffInvitesService],
})
export class RestaurantsModule {}
