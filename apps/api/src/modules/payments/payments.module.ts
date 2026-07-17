import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PaymentReconciliationProcessor } from './payment-reconciliation.processor';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { RazorpayService } from './razorpay.service';

@Module({
  // Stripe delivers order payments AND subscription billing to the one webhook this
  // module owns; it hands the subscription/invoice events to SubscriptionsService.
  // RazorpayService is the India payment provider (Route); it reuses
  // PaymentsService.markOrderPaid, so the dependency runs one way and there's no cycle.
  imports: [SubscriptionsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, RazorpayService, PaymentReconciliationProcessor],
  exports: [PaymentsService, RazorpayService],
})
export class PaymentsModule {}
