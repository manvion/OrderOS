import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Redis is used for three things:
 *  1. Caching published storefront menus (read-heavy, changes rarely).
 *  2. Distributed locks, so two API instances can't both create an Uber
 *     delivery for the same order.
 *  3. The Uber Direct retry queue (a sorted set keyed by next-attempt time).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    this.client = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
    this.client.on('connect', () => this.logger.log('Redis connected'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (ttlSeconds) await this.client.set(key, raw, 'EX', ttlSeconds);
    else await this.client.set(key, raw);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.client.del(...keys);
  }

  /** Delete every key matching a glob. SCAN, not KEYS — never block the server. */
  async delByPattern(pattern: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) await this.client.del(...keys);
    } while (cursor !== '0');
  }

  /**
   * Best-effort distributed lock. Returns a release function, or null if the
   * lock is already held. Callers must treat null as "someone else is doing
   * this" and bail out, not as an error.
   */
  async acquireLock(key: string, ttlSeconds = 30): Promise<(() => Promise<void>) | null> {
    const token = `${process.pid}-${Date.now()}-${Math.random()}`;
    const ok = await this.client.set(`lock:${key}`, token, 'EX', ttlSeconds, 'NX');
    if (ok !== 'OK') return null;

    return async () => {
      // Compare-and-delete: only release a lock we still own, otherwise a slow
      // holder whose TTL expired would delete the next holder's lock.
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end`;
      await this.client.eval(script, 1, `lock:${key}`, token);
    };
  }
}
