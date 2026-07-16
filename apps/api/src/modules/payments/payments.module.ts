import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PaymentReconciliationProcessor } from './payment-reconciliation.processor';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  // Stripe delivers order payments AND subscription billing to the one webhook this
  // module owns; it hands the subscription/invoice events to SubscriptionsService.
  imports: [SubscriptionsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentReconciliationProcessor],
  exports: [PaymentsService],
})
export class PaymentsModule {}
