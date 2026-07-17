import { Module, forwardRef } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { QrModule } from '../qr/qr.module';
import { VercelClient } from '../domains/vercel.client';
import { InvitesController, RestaurantsController } from './restaurants.controller';
import { RestaurantsService } from './restaurants.service';
import { StaffInvitesService } from './staff-invites.service';

@Module({
  // Publishing mints the starter QR codes. No cycle: QrModule doesn't need us.
  imports: [QrModule, forwardRef(() => PaymentsModule)],
  controllers: [RestaurantsController, InvitesController],
  // VercelClient is a stateless wrapper over the Vercel API (ConfigService only), so
  // it's provided directly here rather than importing DomainsModule — publishing
  // registers the storefront's subdomain with Vercel so it gets an HTTPS cert.
  providers: [RestaurantsService, StaffInvitesService, VercelClient],
  exports: [RestaurantsService, StaffInvitesService],
})
export class RestaurantsModule {}
