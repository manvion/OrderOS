import { Module, forwardRef } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { DomainVerifyProcessor } from './domain-verify.processor';
import { DomainResolveController, DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { VercelClient } from './vercel.client';

@Module({
  // A domain going live registers it with Stripe for Apple Pay.
  imports: [forwardRef(() => PaymentsModule)],
  controllers: [DomainsController, DomainResolveController],
  providers: [VercelClient, DomainsService, DomainVerifyProcessor],
  // main.ts asks whether an Origin is a live storefront, from inside the CORS
  // callback — which runs before routing, and therefore before any guard.
  exports: [DomainsService],
})
export class DomainsModule {}
