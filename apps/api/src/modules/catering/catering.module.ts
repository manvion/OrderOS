import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { CateringController } from './catering.controller';
import { CateringPublicController } from './catering-public.controller';
import { CateringService } from './catering.service';

@Module({
  // PaymentsService opens the Stripe checkout for paid packages.
  imports: [PaymentsModule],
  controllers: [CateringController, CateringPublicController],
  providers: [CateringService],
  exports: [CateringService],
})
export class CateringModule {}
