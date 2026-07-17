import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { PaymentsService } from './payments.service';

/**
 * India payments via Razorpay Route — the counterpart to Stripe Connect for the one
 * country Stripe can't pay out to. Talks Razorpay's REST API directly (no SDK to
 * install), collects UPI / cards / netbanking, and uses Route `transfers` to split
 * each payment to the restaurant's linked account while we keep our commission.
 *
 * The customer pays through Razorpay's Checkout MODAL (opened client-side with an
 * order id) rather than a redirect, so this returns order details, not a URL, and
 * the browser posts the signed result back to `verifyAndCapture`. Capture funnels
 * into the SAME PaymentsService.markOrderPaid the Stripe webhook uses, so an Indian
 * order becomes real money exactly like any other.
 *
 * Going live needs a Razorpay merchant account (RAZORPAY_KEY_ID / _SECRET) and each
 * restaurant's Route linked account created + KYC-verified on Razorpay's side.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private readonly keyId?: string;
  private readonly keySecret?: string;
  private readonly base = 'https://api.razorpay.com/v1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly payments: PaymentsService,
  ) {
    this.keyId = this.config.get<string>('RAZORPAY_KEY_ID');
    this.keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET');
  }

  /** Configured with real keys? The checkout router checks this before offering it. */
  get available(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  private assertConfigured(): void {
    if (!this.available) {
      throw new BadRequestException(
        'Razorpay is not configured on this deployment (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).',
      );
    }
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  private async call<T>(method: 'POST' | 'GET', path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader(),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (json.error as { description?: string } | undefined)?.description ?? res.statusText;
      throw new BadRequestException(`Razorpay: ${err}`);
    }
    return json as T;
  }

  /**
   * Create the Razorpay order the Checkout modal opens with. Splits the payout to the
   * restaurant's Route account (total minus our commission) so, like Stripe, the
   * restaurant's balance ends up equal to what our analytics shows them.
   */
  async createRouteOrder(orderId: string) {
    this.assertConfigured();

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true, restaurant: true },
    });
    if (!order?.payment) throw new NotFoundException('Order not found');
    if (order.payment.status === 'PAID') {
      throw new BadRequestException('This order has already been paid');
    }
    const r = order.restaurant;
    if (!r.razorpayEnabled || !r.razorpayAccountId) {
      throw new BadRequestException('This restaurant cannot accept payments yet');
    }

    // INR is stored in paise already, which is exactly Razorpay's unit.
    const amount = order.payment.amountCents;
    const commission = order.payment.platformFeeCents;
    const transferToRestaurant = Math.max(0, amount - commission);

    const rzpOrder = await this.call<{ id: string }>('POST', '/orders', {
      amount,
      currency: 'INR',
      receipt: order.orderNumber,
      notes: { orderId: order.id, orderNumber: order.orderNumber, restaurantId: r.id },
      // Route: settle the restaurant's share to their linked account; we keep the rest.
      transfers: [
        {
          account: r.razorpayAccountId,
          amount: transferToRestaurant,
          currency: 'INR',
          notes: { orderId: order.id },
          on_hold: false,
        },
      ],
    });

    await this.prisma.payment.update({
      where: { id: order.payment.id },
      data: { razorpayOrderId: rzpOrder.id },
    });

    await this.audit.log({
      restaurantId: r.id,
      action: 'razorpay.order_created',
      entityType: 'Payment',
      entityId: order.payment.id,
      metadata: { orderNumber: order.orderNumber, razorpayOrderId: rzpOrder.id },
    });

    return {
      provider: 'RAZORPAY' as const,
      razorpayOrderId: rzpOrder.id,
      keyId: this.keyId!,
      amount,
      currency: 'INR',
      restaurantName: r.name,
      orderNumber: order.orderNumber,
      prefill: { name: order.customerName, email: order.customerEmail, contact: order.customerPhone },
    };
  }

  /**
   * The browser hands back the signed result of a successful Checkout. Verify the
   * HMAC signature (proof Razorpay, not the client, produced it) and mark the order
   * paid through the shared path. Idempotent via markOrderPaid.
   */
  async verifyAndCapture(input: {
    orderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }): Promise<{ paid: boolean }> {
    this.assertConfigured();

    const order = await this.prisma.order.findUnique({
      where: { id: input.orderId },
      include: { payment: true },
    });
    if (!order?.payment?.razorpayOrderId) {
      throw new BadRequestException('No Razorpay order to verify for this order');
    }

    const expected = createHmac('sha256', this.keySecret!)
      .update(`${order.payment.razorpayOrderId}|${input.razorpayPaymentId}`)
      .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(input.razorpaySignature);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      this.logger.warn(`Bad Razorpay signature for order ${order.orderNumber}`);
      throw new BadRequestException('Payment signature verification failed');
    }

    await this.payments.markOrderPaid(input.orderId, {
      paymentFields: { razorpayPaymentId: input.razorpayPaymentId },
      auditMeta: { razorpayPaymentId: input.razorpayPaymentId },
    });
    return { paid: true };
  }

  /** Refund an India order, in full or in part, against its Razorpay payment. */
  async refund(paymentId: string, amountCents?: number): Promise<{ refundId: string }> {
    this.assertConfigured();
    const refund = await this.call<{ id: string }>(
      'POST',
      `/payments/${paymentId}/refund`,
      amountCents ? { amount: amountCents } : {},
    );
    return { refundId: refund.id };
  }
}
