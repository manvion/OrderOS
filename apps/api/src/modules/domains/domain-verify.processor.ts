import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DomainsService } from './domains.service';
import { VercelClient } from './vercel.client';

/**
 * Watches domains whose DNS hasn't propagated yet.
 *
 * DNS is not instant and is not ours to control — a registrar's TTL can be an hour,
 * and some are worse. The owner pastes two records, closes the tab, and reasonably
 * expects it to just start working. This is the thing that makes that true, instead
 * of making them come back and click "check" until it does.
 *
 * Backs off as attempts pile up: a domain that hasn't resolved after two hours is
 * probably typo'd, and polling it every minute for a week helps nobody.
 */
@Injectable()
export class DomainVerifyProcessor {
  private readonly logger = new Logger(DomainVerifyProcessor.name);
  private running = false;

  constructor(
    private readonly domains: DomainsService,
    private readonly vercel: VercelClient,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    if (!this.vercel.isConfigured || this.running) return;
    this.running = true;

    try {
      const pending = await this.domains.listPending();
      if (pending.length === 0) return;

      let live = 0;

      for (const domain of pending) {
        // Back off: check every 5 min for the first half hour, then every ~30 min.
        const minutesSince = domain.lastCheckedAt
          ? (Date.now() - domain.lastCheckedAt.getTime()) / 60_000
          : Infinity;
        const interval = domain.checkAttempts < 6 ? 5 : 30;
        if (minutesSince < interval) continue;

        const result = await this.domains.check(domain.id);
        if (result.status === 'ACTIVE') {
          live++;
          this.logger.log(`${domain.domain} went live`);
        }
      }

      if (live > 0) this.logger.log(`${live} custom domain(s) went live this sweep`);
    } catch (err) {
      this.logger.error(`Domain verification sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
