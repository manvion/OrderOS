import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Restaurant } from '@prisma/client';
import {
  billedAmountMinor,
  commissionBpsForTier,
  formatMoney,
  getPlan,
  planPricingTable,
  PLAN_TIERS,
  type BillingInterval,
  type PlanTier,
  type SubscriptionStatus,
} from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { effectiveCommissionBps } from '../../common/plan/plan.util';
import { EmailService } from '../notifications/email.service';

/**
 * The software subscription — how a restaurant pays US.
 *
 * Careful not to confuse this with PaymentsService, which is how a restaurant gets
 * paid by its CUSTOMERS. That runs on each restaurant's own connected Stripe
 * account (destination charges, application fees). THIS runs on the platform's own
 * Stripe account: Stripe Billing subscriptions, a customer per restaurant, invoices
 * we collect. The two never share a customer or an account.
 *
 * The subscription and the per-order commission move together: landing on a tier
 * sets both what the restaurant can do AND the commission it pays, in one place
 * (`applyPlan`), so the two can't drift.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {
    this.stripe = new Stripe(this.config.getOrThrow<string>('STRIPE_SECRET_KEY'), {
      apiVersion: '2025-02-24.acacia',
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
  }

  // --- Reads -----------------------------------------------------------------

  /** The public pricing table for a currency (or country code). Drives the landing page. */
  getPricing(currencyOrCountry?: string) {
    const currency = currencyOrCountry?.trim() || 'USD';
    return {
      currency,
      tiers: planPricingTable(currency).map((price) => ({
        ...price,
        plan: getPlan(price.tier),
      })),
    };
  }

  /** The current plan state for one restaurant, plus the upgrade options it can pick. */
  async getPlanState(restaurantId: string) {
    const r = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        currency: true,
        planTier: true,
        subscriptionStatus: true,
        billingInterval: true,
        planCurrentPeriodEnd: true,
        stripeSubscriptionId: true,
        platformFeeBps: true,
        commissionOverridden: true,
      },
    });
    if (!r) throw new NotFoundException('Restaurant not found');

    return {
      tier: r.planTier,
      status: r.subscriptionStatus,
      interval: r.billingInterval,
      currentPeriodEnd: r.planCurrentPeriodEnd,
      currency: r.currency,
      plan: getPlan(r.planTier),
      // Derived from the plan (not the stored column), so the rate a restaurant sees
      // always matches the plan's current rate. See effectiveCommissionBps.
      commissionBps: effectiveCommissionBps(r),
      /** True when a live Stripe subscription exists — i.e. "Manage billing" should show. */
      manageable: Boolean(r.stripeSubscriptionId),
      /** Every tier, priced in this restaurant's currency, ready to render as upgrade cards. */
      pricing: planPricingTable(r.currency).map((price) => ({
        ...price,
        plan: getPlan(price.tier),
        current: price.tier === r.planTier,
      })),
    };
  }

  // --- Checkout & portal -----------------------------------------------------

  /**
   * Start a Stripe Checkout for a paid plan.
   *
   * Priced in the restaurant's OWN currency from our hand-set table (plans.ts), not
   * a live FX conversion — a Mumbai restaurant is billed ₹1,499, full stop. The
   * amount rides as inline price_data so we never have to pre-create and sync a
   * Stripe Price per (tier × interval × currency), which is a combinatorial mess to
   * keep correct.
   */
  async createCheckoutSession(
    restaurantId: string,
    tier: PlanTier,
    interval: BillingInterval,
  ): Promise<{ checkoutUrl: string }> {
    if (tier === 'STARTER') {
      throw new BadRequestException('The Starter plan is free — there is nothing to check out');
    }

    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const customerId = await this.ensureCustomer(restaurant);
    const currency = restaurant.currency.toLowerCase();
    const amount = billedAmountMinor(tier, interval, restaurant.currency);
    const plan = getPlan(tier);
    const webUrl = this.config.getOrThrow<string>('WEB_URL');

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: amount,
              recurring: { interval: interval === 'ANNUAL' ? 'year' : 'month' },
              product_data: {
                name: `DineDirect ${plan.name}`,
                description: interval === 'ANNUAL' ? 'Annual plan (2 months free)' : 'Monthly plan',
              },
            },
          },
        ],
        // The subscription carries the tier/interval so the webhook can set the plan
        // from Stripe's own record, not from a query param we'd have to trust.
        subscription_data: { metadata: { restaurantId, tier, interval } },
        metadata: { kind: 'subscription', restaurantId, tier, interval },
        success_url: `${webUrl}/dashboard/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${webUrl}/dashboard/billing?checkout=cancelled`,
        allow_promotion_codes: true,
      },
      { idempotencyKey: `sub-checkout:${restaurantId}:${tier}:${interval}` },
    );

    if (!session.url) {
      throw new BadRequestException('Stripe did not return a checkout URL');
    }
    return { checkoutUrl: session.url };
  }

  /** A door into Stripe's hosted billing portal — change card, switch plan, cancel. */
  async createPortalLink(restaurantId: string): Promise<{ url: string }> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { stripeCustomerId: true },
    });
    if (!restaurant?.stripeCustomerId) {
      throw new BadRequestException('No billing account yet — subscribe to a paid plan first');
    }
    const webUrl = this.config.getOrThrow<string>('WEB_URL');
    const session = await this.stripe.billingPortal.sessions.create({
      customer: restaurant.stripeCustomerId,
      return_url: `${webUrl}/dashboard/billing`,
    });
    return { url: session.url };
  }

  /**
   * Apply a just-completed checkout immediately, from the success page, without
   * waiting on the webhook.
   *
   * Stripe redirects the owner back the instant they pay — often a beat before the
   * `checkout.session.completed` webhook lands (and it rescues the case where that
   * webhook is misconfigured entirely). So the return page calls this with the
   * session id and the plan flips right away. Idempotent: it routes through the same
   * onCheckoutCompleted the webhook uses, and a later webhook re-applying the same
   * state is harmless.
   */
  async reconcileCheckout(restaurantId: string, sessionId: string) {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);

    // Guard: a subscription checkout, for THIS restaurant, that actually completed.
    if (session.mode !== 'subscription') return this.getPlanState(restaurantId);
    if (session.metadata?.restaurantId && session.metadata.restaurantId !== restaurantId) {
      throw new BadRequestException('That checkout session belongs to another restaurant');
    }
    if (session.status === 'complete' || session.payment_status === 'paid') {
      await this.onCheckoutCompleted(session);
    }
    return this.getPlanState(restaurantId);
  }

  private async ensureCustomer(restaurant: Restaurant): Promise<string> {
    if (restaurant.stripeCustomerId) return restaurant.stripeCustomerId;
    const customer = await this.stripe.customers.create({
      email: restaurant.email,
      name: restaurant.name,
      metadata: { restaurantId: restaurant.id, slug: restaurant.slug },
    });
    await this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { stripeCustomerId: customer.id },
    });
    return customer.id;
  }

  // --- Webhook handlers (called by PaymentsService.handleEvent) ---------------

  /**
   * A subscription checkout finished. The subscription itself is the source of
   * truth, so we just stamp its id/customer on the restaurant and defer to the
   * subscription-updated path for the tier and dates.
   */
  async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const restaurantId = session.metadata?.restaurantId;
    const subscriptionId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (!restaurantId || !subscriptionId) return;

    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id;
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        stripeSubscriptionId: subscriptionId,
        ...(customerId ? { stripeCustomerId: customerId } : {}),
      },
    });

    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    await this.onSubscriptionChanged(subscription);
  }

  /** Created / updated / renewed — reconcile the restaurant to Stripe's record. */
  async onSubscriptionChanged(subscription: Stripe.Subscription): Promise<void> {
    const restaurant = await this.findRestaurantForSubscription(subscription);
    if (!restaurant) return;

    const tier = (subscription.metadata?.tier as PlanTier) ?? restaurant.planTier;
    const interval =
      (subscription.metadata?.interval as BillingInterval) ?? restaurant.billingInterval ?? 'MONTHLY';
    const status = this.mapStatus(subscription.status);

    // A subscription that has fully ended drops the restaurant back to the free tier.
    if (status === 'CANCELED') {
      await this.downgradeToStarter(restaurant.id, 'subscription_canceled');
      return;
    }

    await this.applyPlan(restaurant.id, tier, {
      status,
      interval,
      periodEnd: periodEndOf(subscription),
      stripeSubscriptionId: subscription.id,
      source: 'stripe',
    });
  }

  async onSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
    const restaurant = await this.findRestaurantForSubscription(subscription);
    if (!restaurant) return;
    await this.downgradeToStarter(restaurant.id, 'subscription_deleted');
  }

  /**
   * A subscription invoice was paid — the initial charge or a monthly/annual
   * renewal. Clears any PAST_DUE flag and emails the restaurant a branded receipt
   * with a link to the actual invoice. (Stripe also generates the invoice and can
   * email its own copy; this is the on-brand one, and it never depends on the
   * dashboard email setting being on.)
   */
  async onInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
    const restaurant = await this.findRestaurantForInvoice(invoice);
    if (!restaurant) return;

    if (restaurant.subscriptionStatus === 'PAST_DUE') {
      await this.prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { subscriptionStatus: 'ACTIVE' },
      });
    }

    await this.emailInvoice(restaurant, invoice, 'paid');
    this.logger.log(`Subscription invoice ${invoice.id} paid for ${restaurant.name}`);
  }

  /** A renewal payment failed — hold the features on, flag PAST_DUE, and email them. */
  async onInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
    const restaurant = await this.findRestaurantForInvoice(invoice);
    if (!restaurant) return;
    await this.prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { subscriptionStatus: 'PAST_DUE' },
    });
    await this.emailInvoice(restaurant, invoice, 'failed');
    this.logger.warn(`Subscription ${restaurant.stripeSubscriptionId} is PAST_DUE (invoice ${invoice.id} failed)`);
  }

  private async findRestaurantForInvoice(invoice: Stripe.Invoice) {
    const subId =
      typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription?.id;
    const customerId =
      typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    if (!subId && !customerId) return null;
    return this.prisma.restaurant.findFirst({
      where: subId ? { stripeSubscriptionId: subId } : { stripeCustomerId: customerId! },
    });
  }

  /** A branded receipt (or dunning notice) for a subscription invoice. */
  private async emailInvoice(
    restaurant: Restaurant,
    invoice: Stripe.Invoice,
    kind: 'paid' | 'failed',
  ): Promise<void> {
    const to = restaurant.notifyEmail || restaurant.email;
    if (!to) return;

    const cents = kind === 'paid' ? (invoice.amount_paid ?? invoice.amount_due) : invoice.amount_due;
    const amount = formatMoney(cents, (invoice.currency ?? restaurant.currency).toUpperCase());
    const planName = getPlan(restaurant.planTier).name;
    const period =
      restaurant.billingInterval === 'ANNUAL' ? 'yearly' : restaurant.billingInterval === 'MONTHLY' ? 'monthly' : '';
    const link = invoice.hosted_invoice_url ?? invoice.invoice_pdf ?? null;
    const linkBtn = link
      ? `<p style="margin:20px 0 0"><a href="${link}" style="display:inline-block;background:${restaurant.brandPrimaryColor};color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px">View invoice</a></p>`
      : '';

    const body =
      kind === 'paid'
        ? `<h2 style="margin:0 0 8px;font-size:20px">Payment received — thank you</h2>
           <p style="margin:0;color:#475569;font-size:15px">
             Your ${period} <strong>DineDirect ${planName}</strong> subscription has been billed
             <strong>${amount}</strong>. Everything on your plan stays on — nothing for you to do.
           </p>${linkBtn}`
        : `<h2 style="margin:0 0 8px;font-size:20px">We couldn’t process your payment</h2>
           <p style="margin:0;color:#475569;font-size:15px">
             The ${amount} charge for your <strong>DineDirect ${planName}</strong> subscription
             didn’t go through. Please update your card to keep your paid features — you can do it
             from Billing in your dashboard.
           </p>${linkBtn}`;

    await this.email.sendRaw({
      to,
      subject:
        kind === 'paid'
          ? `Your DineDirect ${planName} receipt — ${amount}`
          : `Action needed: payment failed for DineDirect ${planName}`,
      body,
      restaurant: {
        name: restaurant.name,
        logoUrl: restaurant.logoUrl,
        brandPrimaryColor: restaurant.brandPrimaryColor,
        phone: restaurant.phone,
      },
    });
  }

  // --- Admin (comp / free upgrade) -------------------------------------------

  /**
   * Put a restaurant on a plan without charging them — a comp, a promised free
   * upgrade, a beta partner. No Stripe subscription is created; if one already
   * exists it is left alone (they may still be paying for a lower tier, and we
   * don't want to cancel their card on file). SUPER_ADMIN only, upstream.
   */
  async adminSetPlan(
    restaurantId: string,
    tier: PlanTier,
    adminEmail: string,
  ) {
    const before = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { planTier: true, name: true },
    });
    if (!before) throw new NotFoundException('Restaurant not found');

    await this.applyPlan(restaurantId, tier, {
      status: 'ACTIVE',
      interval: null,
      periodEnd: null,
      source: 'comp',
    });

    await this.audit.log({
      restaurantId,
      action: 'platform.plan_changed',
      entityType: 'Restaurant',
      entityId: restaurantId,
      metadata: { byAdmin: adminEmail, from: before.planTier, to: tier, comp: true },
    });
    this.logger.warn(`Admin ${adminEmail} comped ${before.name}: ${before.planTier} -> ${tier}`);

    return this.getPlanState(restaurantId);
  }

  // --- The one place a plan is written ---------------------------------------

  /**
   * Land a restaurant on a tier and set everything that follows from it in a single
   * write: the tier, the subscription bookkeeping, AND the per-order commission.
   *
   * The commission is the plan's rate UNLESS a SUPER_ADMIN has negotiated a custom
   * one (`commissionOverridden`) — in which case we leave their number untouched, so
   * a routine renewal webhook can't undo a hand-shake deal.
   */
  private async applyPlan(
    restaurantId: string,
    tier: PlanTier,
    opts: {
      status: SubscriptionStatus;
      interval: BillingInterval | null;
      periodEnd: Date | null;
      stripeSubscriptionId?: string;
      source: 'stripe' | 'comp';
    },
  ) {
    const current = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { commissionOverridden: true },
    });

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        planTier: tier,
        subscriptionStatus: opts.status,
        billingInterval: opts.interval,
        planCurrentPeriodEnd: opts.periodEnd,
        ...(opts.stripeSubscriptionId ? { stripeSubscriptionId: opts.stripeSubscriptionId } : {}),
        // Drive commission from the plan, unless a custom rate was negotiated.
        ...(current?.commissionOverridden ? {} : { platformFeeBps: commissionBpsForTier(tier) }),
      },
    });
  }

  private async downgradeToStarter(restaurantId: string, reason: string) {
    const current = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { commissionOverridden: true },
    });
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        planTier: 'STARTER',
        subscriptionStatus: 'ACTIVE',
        billingInterval: null,
        planCurrentPeriodEnd: null,
        stripeSubscriptionId: null,
        ...(current?.commissionOverridden ? {} : { platformFeeBps: commissionBpsForTier('STARTER') }),
      },
    });
    this.logger.log(`Restaurant ${restaurantId} downgraded to Starter (${reason})`);
  }

  private async findRestaurantForSubscription(subscription: Stripe.Subscription) {
    const byMeta = subscription.metadata?.restaurantId;
    if (byMeta) {
      const r = await this.prisma.restaurant.findUnique({
        where: { id: byMeta },
        select: { id: true, planTier: true, billingInterval: true },
      });
      if (r) return r;
    }
    return this.prisma.restaurant.findFirst({
      where: { stripeSubscriptionId: subscription.id },
      select: { id: true, planTier: true, billingInterval: true },
    });
  }

  private mapStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
    switch (status) {
      case 'active':
        return 'ACTIVE';
      case 'trialing':
        return 'TRIALING';
      case 'past_due':
      case 'unpaid':
        return 'PAST_DUE';
      case 'canceled':
      case 'incomplete_expired':
        return 'CANCELED';
      default:
        // incomplete / paused — treat as not-yet-active, keep features off.
        return 'PAST_DUE';
    }
  }
}

/**
 * Where the current paid period ends. Stripe has moved this field between the
 * subscription and its items across API versions, so read both rather than pin our
 * correctness to one shape.
 */
function periodEndOf(subscription: Stripe.Subscription): Date | null {
  const top = (subscription as unknown as { current_period_end?: number }).current_period_end;
  const item = subscription.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const secs = top ?? item?.current_period_end;
  return secs ? new Date(secs * 1000) : null;
}
