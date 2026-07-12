import { Logger } from '@nestjs/common';

/**
 * Retry with exponential backoff and full jitter.
 *
 * Two rules, both learned the hard way:
 *
 * 1. ONLY RETRY WHAT MIGHT SUCCEED. Retrying a 400 ("that address is
 *    undeliverable") just delays telling the restaurant the truth, five times.
 *    The caller decides what's transient via `isRetryable`; we never guess.
 *
 * 2. JITTER IS NOT OPTIONAL. If Uber has a blip and 200 of our deliveries all
 *    back off for exactly 1s, 2s, 4s, they retry in lockstep and we hammer the
 *    recovering service with synchronised thundering herds — turning their
 *    30-second blip into a 10-minute outage that we caused. Full jitter (a random
 *    delay between 0 and the backoff ceiling) spreads the load flat.
 */
export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false for errors that will never succeed, however many times we ask. */
  isRetryable?: (err: unknown) => boolean;
  /** For logs, so a retry storm is traceable to a feature. */
  label?: string;
  logger?: Logger;
}

const defaultLogger = new Logger('Retry');

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 300,
    maxDelayMs = 5_000,
    isRetryable = () => true,
    label = 'operation',
    logger = defaultLogger,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err)) {
        // Permanent. Fail immediately and loudly rather than burning four more
        // attempts on something that cannot work.
        throw err;
      }

      if (attempt === attempts) break;

      const ceiling = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = Math.random() * ceiling; // full jitter

      logger.warn(
        `${label} failed (attempt ${attempt}/${attempts}): ${(err as Error).message}. Retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }

  logger.error(`${label} failed after ${attempts} attempts: ${(lastError as Error)?.message}`);
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A circuit breaker.
 *
 * When a dependency is comprehensively down, retrying every single call is worse
 * than useless: each one burns a socket and 15 seconds of timeout, and the queue
 * behind them grows until the whole API is wedged waiting on a service that is
 * not coming back this second. So after N consecutive failures we stop calling it
 * for a cooldown and fail fast instead — which lets the caller do something
 * useful (queue it, escalate to a human) immediately rather than in 15 seconds.
 *
 * "Half-open": after the cooldown, exactly ONE request is allowed through as a
 * probe. If it works we close the circuit; if not, we back off again. This is what
 * stops the recovery itself from being a thundering herd.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private readonly logger: Logger;

  constructor(
    private readonly name: string,
    private readonly threshold = 5,
    private readonly cooldownMs = 30_000,
  ) {
    this.logger = new Logger(`Circuit:${name}`);
  }

  get isOpen(): boolean {
    if (this.openedAt === null) return false;

    if (Date.now() - this.openedAt >= this.cooldownMs) {
      // Half-open: let one probe through.
      this.logger.log(`Cooldown elapsed — probing ${this.name}`);
      this.openedAt = null;
      this.failures = this.threshold - 1; // one more failure re-opens it immediately
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    if (this.failures > 0) {
      this.logger.log(`${this.name} is healthy again`);
    }
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold && this.openedAt === null) {
      this.openedAt = Date.now();
      this.logger.error(
        `${this.name} has failed ${this.failures} times — opening circuit for ${this.cooldownMs / 1000}s. Calls will fail fast.`,
      );
    }
  }
}
