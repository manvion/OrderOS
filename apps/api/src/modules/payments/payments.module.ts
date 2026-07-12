import { Module } from '@nestjs/common';
import { PaymentReconciliationProcessor } from './payment-reconciliation.processor';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentReconciliationProcessor],
  exports: [PaymentsService],
})
export class PaymentsModule {}
