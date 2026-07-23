import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { RedisService } from '../../common/redis/redis.service';
import { CircuitBreaker, withRetry } from '../../common/resilience/retry';

/** Uber Direct's own status vocabulary, as it appears on the wire. */
export type UberDeliveryStatus =
  | 'pending'
  | 'pickup'
  | 'pickup_complete'
  | 'dropoff'
  | 'delivered'
  | 'canceled'
  | 'returned';

export interface UberAddress {
  street_address: string[];
  city: string;
  state: string;
  zip_code: string;
  country: string;
}

export interface UberQuoteRequest {
  pickup_address: string; // JSON-stringified UberAddress
  dropoff_address: string;
  pickup_latitude?: number;
  pickup_longitude?: number;
  dropoff_latitude?: number;
  dropoff_longitude?: number;
  pickup_ready_dt?: string;
  pickup_deadline_dt?: string;
  manifest_total_value?: number; // cents
}

export interface UberQuote {
  id: string;
  fee: number; // cents
  currency: string;
  expires: string;
  dropoff_eta?: string;
  duration?: number;
  pickup_duration?: number;
}

export interface UberDeliveryRequest {
  quote_id?: string;
  pickup_name: string;
  pickup_address: string;
  pickup_phone_number: string;
  pickup_business_name?: string;
  pickup_notes?: string;
  pickup_latitude?: number;
  pickup_longitude?: number;

  dropoff_name: string;
  dropoff_address: string;
  dropoff_phone_number: string;
  dropoff_notes?: string;
  dropoff_latitude?: number;
  dropoff_longitude?: number;

  manifest_items: Array<{
    name: string;
    quantity: number;
    size: 'small' | 'medium' | 'large' | 'xlarge';
    price?: number;
  }>;
  manifest_total_value: number;
  manifest_reference?: string;

  external_id?: string;
  tip?: number;

  /** Sandbox-only: activates Uber's Robo Courier simulator. See createDelivery(). */
  test_specifications?: { robo_courier_specification: { mode: 'auto' } };
}

export interface UberDelivery {
  id: string;
  status: UberDeliveryStatus;
  tracking_url: string;
  fee: number;
  currency: string;
  quote_id?: string;
  pickup_eta?: string;
  dropoff_eta?: string;
  courier?: {
    name?: string;
    phone_number?: string;
    vehicle_type?: string;
    location?: { lat: number; lng: number };
  };
}

/** See UberClient.sandboxMode. */
const ROBO_COURIER_AUTO = {
  test_specifications: { robo_courier_specification: { mode: 'auto' as const } },
};

/** Thrown for 4xx responses: the request itself is wrong and retrying won't fix it. */
export class UberClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'UberClientError';
  }
}

/** Thrown for 5xx/network failures: transient, so the retry queue should pick it up. */
export class UberServerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UberServerError';
  }
}

/**
 * Thin HTTP client for Uber Direct.
 *
 * Its one non-obvious job is distinguishing "this will never work" (4xx — bad
 * address, order too large) from "try again in a minute" (5xx, timeout). The
 * delivery service branches on that: the first surfaces to the restaurant
 * immediately, the second goes on the retry queue silently.
 */
@Injectable()
export class UberClient {
  private readonly logger = new Logger(UberClient.name);
  private static readonly TOKEN_CACHE_KEY = 'uber:access_token';
  private static readonly REQUEST_TIMEOUT_MS = 15_000;

  /** Opens after 5 consecutive server-side failures; probes again after 30s. */
  private readonly breaker = new CircuitBreaker('uber-direct', 5, 30_000);

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  get isConfigured(): boolean {
    return Boolean(
      this.config.get('UBER_CLIENT_ID') &&
        this.config.get('UBER_CLIENT_SECRET') &&
        this.config.get('UBER_CUSTOMER_ID'),
    );
  }

  /**
   * Sandbox credentials never dispatch a real courier -- there is no test fleet to
   * match against. Uber's own fix is Robo Courier, a simulator that only activates
   * when `test_specifications` is present on Create Delivery; without it, a sandbox
   * delivery sits at "pending" forever, which looks exactly like a stuck order but
   * is the test environment doing nothing, not a bug. Opt-in and off by default so
   * a production deployment never sends a field a live account doesn't expect.
   */
  private get sandboxMode(): boolean {
    return this.config.get<boolean>('UBER_SANDBOX_MODE') ?? false;
  }

  /**
   * OAuth2 client_credentials token, cached in Redis across all API instances.
   *
   * Uber's tokens last 30 days but we cache for the token's own TTL minus a 5
   * minute safety margin — a token that expires between our check and Uber's
   * check would surface as a mystery 401 in the middle of a dinner rush.
   */
  private async getAccessToken(): Promise<string> {
    const cached = await this.redis.get<string>(UberClient.TOKEN_CACHE_KEY);
    if (cached) return cached;

    const body = new URLSearchParams({
      client_id: this.config.getOrThrow<string>('UBER_CLIENT_ID'),
      client_secret: this.config.getOrThrow<string>('UBER_CLIENT_SECRET'),
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    });

    const res = await fetch(this.config.getOrThrow<string>('UBER_AUTH_URL'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(UberClient.REQUEST_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new UberServerError(`Uber auth failed (${res.status}): ${text}`, res.status);
    }

    const json = (await res.json()) as { access_token: string; expires_in: number };
    const ttl = Math.max(60, json.expires_in - 300);
    await this.redis.set(UberClient.TOKEN_CACHE_KEY, json.access_token, ttl);

    this.logger.log(`Obtained Uber access token (valid ${json.expires_in}s)`);
    return json.access_token;
  }

  /**
   * Every call to Uber goes through here, and therefore through a retry with
   * jittered backoff and a circuit breaker.
   *
   * The retry only fires for UberServerError (5xx, timeouts, network) — never for
   * UberClientError (4xx), because retrying "that address is undeliverable" five
   * times just makes the restaurant wait longer to hear the truth.
   */
  private async request<T>(path: string, init: RequestInit & { retryOn401?: boolean } = {}): Promise<T> {
    if (this.breaker.isOpen) {
      // Uber is comprehensively down. Fail immediately rather than burning 15
      // seconds of timeout — the caller (the retry queue, the watchdog) can do
      // something useful with a fast failure and nothing with a slow one.
      throw new UberServerError('Uber is currently unavailable (circuit open)');
    }

    try {
      const result = await withRetry(() => this.rawRequest<T>(path, init), {
        attempts: 3,
        baseDelayMs: 400,
        maxDelayMs: 4_000,
        // Only transient failures. A 4xx is Uber telling us something true.
        isRetryable: (err) => err instanceof UberServerError,
        label: `Uber ${init.method ?? 'GET'} ${path}`,
        logger: this.logger,
      });

      this.breaker.recordSuccess();
      return result;
    } catch (err) {
      // Only server-side failures count against the circuit. A stream of bad
      // addresses is not an outage, and must not trip the breaker for everyone.
      if (err instanceof UberServerError) {
        this.breaker.recordFailure();
      }
      throw err;
    }
  }

  private async rawRequest<T>(
    path: string,
    init: RequestInit & { retryOn401?: boolean } = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    const baseUrl = this.config.getOrThrow<string>('UBER_API_BASE_URL');

    let res: Response;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
        signal: AbortSignal.timeout(UberClient.REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error or timeout — always transient.
      throw new UberServerError(`Uber request to ${path} failed: ${(err as Error).message}`);
    }

    // A 401 means our cached token was revoked early. Drop it and retry once;
    // if it happens twice, our credentials are genuinely wrong.
    if (res.status === 401 && init.retryOn401 !== false) {
      await this.redis.del(UberClient.TOKEN_CACHE_KEY);
      return this.rawRequest<T>(path, { ...init, retryOn401: false });
    }

    if (!res.ok) {
      const text = await res.text();
      let code: string | undefined;
      let message = text;
      try {
        const parsed = JSON.parse(text) as {
          code?: string;
          message?: string;
          params?: Record<string, unknown>;
          metadata?: Record<string, unknown>;
        };
        code = parsed.code;
        message = parsed.message ?? text;
        // Uber says WHICH field is wrong in `params`/`metadata`. A bare "the parameters
        // of your request were invalid" is unactionable without it, so fold the specific
        // field(s) into the message the restaurant actually sees.
        const detail = parsed.params ?? parsed.metadata;
        if (detail && typeof detail === 'object' && Object.keys(detail).length > 0) {
          const fields = Object.entries(detail)
            .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
            .join('; ');
          message = `${message} — ${fields}`;
        }
      } catch {
        // Non-JSON error body; use the raw text.
      }

      if (res.status >= 500) {
        throw new UberServerError(`Uber ${res.status} on ${path}: ${message}`, res.status);
      }
      throw new UberClientError(message, res.status, code);
    }

    return (await res.json()) as T;
  }

  private get customerPath(): string {
    return `/v1/customers/${this.config.getOrThrow<string>('UBER_CUSTOMER_ID')}`;
  }

  async createQuote(req: UberQuoteRequest): Promise<UberQuote> {
    return this.request<UberQuote>(`${this.customerPath}/delivery_quotes`, {
      method: 'POST',
      body: JSON.stringify(req),
    });
  }

  async createDelivery(req: UberDeliveryRequest): Promise<UberDelivery> {
    return this.request<UberDelivery>(`${this.customerPath}/deliveries`, {
      method: 'POST',
      body: JSON.stringify(this.sandboxMode ? { ...req, ...ROBO_COURIER_AUTO } : req),
    });
  }

  async getDelivery(deliveryId: string): Promise<UberDelivery> {
    return this.request<UberDelivery>(`${this.customerPath}/deliveries/${deliveryId}`);
  }

  async cancelDelivery(deliveryId: string): Promise<void> {
    await this.request(`${this.customerPath}/deliveries/${deliveryId}/cancel`, { method: 'POST' });
  }

  /**
   * Verify an Uber webhook's HMAC-SHA256 signature over the raw body.
   *
   * Uses timingSafeEqual, not ===: a plain string compare leaks, through its own
   * timing, how many leading bytes of a forged signature were correct, which is
   * enough to forge one byte at a time.
   */
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    const secret = this.config.get<string>('UBER_WEBHOOK_SECRET');
    if (!secret) {
      // Refusing here is deliberate: silently accepting unsigned webhooks would
      // let anyone mark any delivery "delivered".
      this.logger.error('UBER_WEBHOOK_SECRET is not set — rejecting webhook');
      return false;
    }
    if (!signature) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;

    return timingSafeEqual(a, b);
  }

  /** Format an address the way Uber's API expects it: a JSON string, not an object. */
  static formatAddress(address: {
    street: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
  }): string {
    return JSON.stringify({
      street_address: [address.street],
      city: address.city,
      state: address.state,
      zip_code: address.postalCode,
      country: address.country,
    } satisfies UberAddress);
  }

  assertConfigured(): void {
    if (!this.isConfigured) {
      throw new ServiceUnavailableException(
        'Uber Direct is not configured on this deployment',
      );
    }
  }
}
