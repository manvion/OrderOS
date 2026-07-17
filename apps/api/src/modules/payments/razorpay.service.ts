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
  // Host only — callers pass the versioned path (/v1/orders, /v2/accounts, …).
  private readonly base = 'https://api.razorpay.com';

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

    const rzpOrder = await this.call<{ id: string }>('POST', '/v1/orders', {
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
      `/v1/payments/${paymentId}/refund`,
      amountCents ? { amount: amountCents } : {},
    );
    return { refundId: refund.id };
  }

  // --- Onboarding (Razorpay Route linked account) ----------------------------

  /**
   * The India equivalent of "Connect Stripe": create the restaurant's Route linked
   * account and turn on the Route product, seeded from what we already know about
   * them (name, contact, address, GST). Razorpay then collects the rest of KYC —
   * PAN, bank account, documents — before the account can settle; the owner
   * finishes that on Razorpay's side and we pick up the result in `syncStatus`.
   *
   * Idempotent: a second call returns the account we already made rather than a
   * duplicate. Surfaces Razorpay's own words on failure so "it didn't connect"
   * carries the actual reason (missing field, unsupported business type, …).
   */
  async createLinkedAccount(restaurantId: string, userId?: string) {
    this.assertConfigured();

    const r = await this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
    if (r.country?.toUpperCase() !== 'IN') {
      throw new BadRequestException('Razorpay onboarding is only for restaurants in India');
    }
    if (r.razorpayAccountId) {
      return { accountId: r.razorpayAccountId, alreadyConnected: true };
    }

    let account: { id: string };
    try {
      account = await this.call<{ id: string }>('POST', '/v2/accounts', {
        email: r.email,
        phone: r.phone.replace(/[^\d]/g, '').slice(-10),
        type: 'route',
        legal_business_name: r.legalName || r.name,
        customer_facing_business_name: r.name,
        // We don't collect the entity type, so start as a proprietorship — the most
        // common for an independent restaurant. The owner can correct it during KYC.
        business_type: 'proprietorship',
        profile: {
          category: 'food',
          subcategory: 'restaurant',
          addresses: {
            registered: {
              street1: r.street,
              street2: r.city,
              city: r.city,
              state: r.state,
              postal_code: r.postalCode,
              country: 'IN',
            },
          },
        },
        ...(r.taxId ? { legal_info: { gst: r.taxId } } : {}),
      });
    } catch (err) {
      throw new BadRequestException(`Could not start Razorpay onboarding: ${(err as Error).message}`);
    }

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { razorpayAccountId: account.id },
    });

    // Enable the Route product on the account. Non-fatal — the account exists either
    // way, and this can be retried; we just log if Razorpay wasn't ready for it yet.
    try {
      await this.call('POST', `/v2/accounts/${account.id}/products`, {
        product_name: 'route',
        tnc_accepted: true,
      });
    } catch (err) {
      this.logger.warn(`Route product not yet enabled for ${account.id}: ${(err as Error).message}`);
    }

    await this.audit.log({
      restaurantId,
      userId,
      action: 'razorpay.onboarding_started',
      entityType: 'Restaurant',
      entityId: restaurantId,
      metadata: { razorpayAccountId: account.id },
    });

    return { accountId: account.id, alreadyConnected: false };
  }

  /**
   * Ask Razorpay whether the linked account is live yet, and flip `razorpayEnabled`
   * to match. Called when the owner returns from finishing KYC — we trust Razorpay's
   * status, not a "done" button. Returns what's still needed so the UI can show it.
   */
  async syncStatus(restaurantId: string) {
    this.assertConfigured();

    const r = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { razorpayAccountId: true },
    });
    if (!r.razorpayAccountId) {
      return { connected: false, enabled: false, status: null as string | null };
    }

    const account = await this.call<{
      status?: string;
      activation_details?: { activation_status?: string };
    }>('GET', `/v2/accounts/${r.razorpayAccountId}`);

    const status = account.activation_details?.activation_status ?? account.status ?? null;
    const enabled = status === 'activated';

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { razorpayEnabled: enabled },
    });

    return { connected: true, enabled, status };
  }
}
