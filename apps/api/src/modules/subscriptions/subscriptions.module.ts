import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Exports SubscriptionsService so PaymentsModule can route Stripe Billing webhook
 * events (subscriptions, invoices) to it. This module deliberately does NOT import
 * PaymentsModule — the dependency runs one way, payments -> subscriptions, so there
 * is no cycle.
 */
@Module({
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
