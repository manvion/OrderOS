import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import twilio, { type Twilio } from 'twilio';

export interface SendResult {
  ok: boolean;
  /** Twilio message SID, for tracing into their console. */
  id?: string;
  error?: string;
}

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);
  private readonly client: Twilio | null = null;
  private readonly from: string | undefined;
  private readonly authToken: string | undefined;

  constructor(private readonly config: ConfigService) {
    const sid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    this.from = this.config.get<string>('TWILIO_FROM_NUMBER');

    if (sid && this.authToken && this.from) {
      this.client = twilio(sid, this.authToken);
      this.logger.log('Twilio SMS ready');
    } else {
      this.logger.warn('Twilio not configured — SMS will be logged instead of sent');
    }
  }

  /**
   * Send an SMS. Never throws: a delivery failure is captured in the result and
   * logged by the caller. No notification is worth failing an order over.
   */
  async send(to: string, body: string): Promise<SendResult> {
    if (!this.client || !this.from) {
      this.logger.log(`[SMS stub] -> ${this.mask(to)}: ${body}`);
      return { ok: false, error: 'Twilio not configured (development stub)' };
    }

    try {
      const message = await this.client.messages.create({
        to: this.normalize(to),
        from: this.from,
        body,
      });
      this.logger.log(`SMS sent to ${this.mask(to)} (${message.sid})`);
      return { ok: true, id: message.sid };
    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(`SMS to ${this.mask(to)} failed: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * Verify Twilio's signature on an inbound webhook (a customer replying STOP).
   *
   * Without this, anyone who knows the endpoint could POST `Body=STOP&From=<victim>`
   * and silently unsubscribe a customer from their own order updates — a small,
   * nasty denial of service against someone else's dinner.
   *
   * Twilio signs the full URL plus the POST params, sorted, concatenated.
   */
  verifyWebhookSignature(
    url: string,
    params: Record<string, string>,
    signature: string | undefined,
  ): boolean {
    if (!this.authToken) {
      this.logger.error('TWILIO_AUTH_TOKEN not set — rejecting inbound SMS webhook');
      return false;
    }
    if (!signature) return false;

    const payload = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], url);

    const expected = createHmac('sha1', this.authToken).update(Buffer.from(payload, 'utf-8')).digest('base64');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;

    // Constant-time: a plain === leaks, via timing, how many leading bytes of a
    // forged signature were right.
    return timingSafeEqual(a, b);
  }

  /** Assume US when a number has no country code. */
  private normalize(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (phone.startsWith('+')) return phone;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return `+${digits}`;
  }

  /** Phone numbers are PII. Never write a full one to a log. */
  private mask(phone: string): string {
    return phone.length > 4 ? `***${phone.slice(-4)}` : '***';
  }
}
