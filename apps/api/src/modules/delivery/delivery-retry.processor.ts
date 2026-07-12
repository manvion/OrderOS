import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeliveryService } from './delivery.service';

/**
 * Drains the Uber Direct retry queue every 30 seconds.
 *
 * Safe to run on every API replica: DeliveryService.createDelivery takes a Redis
 * lock per order, so concurrent drains converge on one dispatch rather than
 * sending three couriers.
 */
@Injectable()
export class DeliveryRetryProcessor {
  private readonly logger = new Logger(DeliveryRetryProcessor.name);
  private running = false;

  constructor(private readonly delivery: DeliveryService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async drain(): Promise<void> {
    // Skip if the previous tick is still going — a slow Uber API shouldn't cause
    // overlapping drains to pile up.
    if (this.running) return;
    this.running = true;

    try {
      const { processed, succeeded } = await this.delivery.processRetryQueue();
      if (processed > 0) {
        this.logger.log(`Retry queue: ${succeeded}/${processed} deliveries dispatched`);
      }
    } catch (err) {
      this.logger.error(`Retry queue drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
