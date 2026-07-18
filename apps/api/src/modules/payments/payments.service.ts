import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import type { Prisma } from '@prisma/client';
import { usesRazorpay, type RefundInput } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { effectiveCommissionBps } from '../../common/plan/plan.util';
import { applyInventoryDelta } from '../../common/inventory/inventory.util';
import { applyLoyaltyDelta } from '../../common/loyalty/loyalty.util';
import { storefrontBaseUrl } from '../../common/tenant-url';
import { AuditService } from '../../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    // Stripe Billing (our subscription revenue) rides the SAME webhook as order
    // payments; those events are handed straight to this service.
    private readonly subscriptions: SubscriptionsService,
  ) {
    this.stripe = new Stripe(this.config.getOrThrow<string>('STRIPE_SECRET_KEY'), {
      // Pinned. Stripe ships breaking API changes behind versions, so never let
      // this float — an upgrade must be a deliberate, tested change.
      apiVersion: '2025-02-24.acacia',
      // Stripe's own retry logic. Combined with idempotency keys below, a
      // transient network blip can't double-charge a customer.
      maxNetworkRetries: 2,
      timeout: 15_000,
    });
  }

  // --- Stripe Connect onboarding -------------------------------------------

  /**
   * Each restaurant gets its own Stripe Express account. Money flows customer ->
   * restaurant directly; the platform takes an application fee. We never touch
   * their funds, which keeps us out of money-transmitter territory.
   */
  async createConnectOnboardingLink(restaurantId: string, userId?: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    let accountId = restaurant.stripeAccountId;

    /**
     * A Stripe account's COUNTRY is fixed at creation, forever -- Stripe's form
     * shows it greyed out. So a restaurant that connected while set to the wrong
     * country (the admin create-flow defaulted to US for a while) is otherwise
     * permanently stuck onboarding into the wrong country's banking system.
     *
     * Self-heal while it's still free: if the account hasn't submitted details or
     * taken a charge, it is an empty shell -- delete it and let the create path
     * below mint a fresh one with the restaurant's CURRENT country. Once
     * onboarding has been submitted, deletion would orphan real KYC data, so we
     * stop and say exactly what's wrong instead.
     */
    if (accountId) {
      const existing = await this.stripe.accounts.retrieve(accountId);

      if (existing.country !== restaurant.country) {
        if (!existing.details_submitted && !existing.charges_enabled) {
          this.logger.warn(
            `Stripe account ${accountId} is ${existing.country} but ${restaurant.slug} is now ` +
              `${restaurant.country} -- recreating the unused account in the right country`,
          );
          await this.stripe.accounts.del(accountId);
          await this.prisma.restaurant.update({
            where: { id: restaurantId },
            data: { stripeAccountId: null },
          });
          accountId = null;
        } else {
          throw new BadRequestException(
            `Your Stripe account was created for ${existing.country} and has already been ` +
              `onboarded -- Stripe does not allow changing a live account's country to ` +
              `${restaurant.country}. Contact support to disconnect and re-onboard.`,
          );
        }
      }
    }

    if (!accountId) {
      let account: Stripe.Account;
      try {
        account = await this.stripe.accounts.create({
          type: 'express',
          country: restaurant.country,
          email: restaurant.email,
          // business_type is deliberately NOT set. It used to be hardcoded to
          // 'company', which a sole trader — most independent restaurants — cannot
          // satisfy, and they got stuck part-way through Stripe's form with no way
          // back. Stripe asks them directly, and it knows the rules for their country
          // better than we do.
          business_profile: {
            name: restaurant.name,
            mcc: '5812', // Eating places / restaurants
            support_phone: restaurant.phone,
          },
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
          metadata: { restaurantId, slug: restaurant.slug },
        });
      } catch (err) {
        /**
         * Stripe's rejections here are CONFIGURATION facts, not transient failures,
         * and Stripe's own message names the fact: "Connect is not enabled on this
         * account", "country IN is not supported", "platform profile incomplete".
         * Swallowed into a generic 500, each becomes "Stripe setup is not working"
         * — a bug report with the diagnosis stripped out of it. Surface the words.
         */
        if (err instanceof Stripe.errors.StripeError && err.type === 'StripeInvalidRequestError') {
          this.logger.warn(
            `Stripe refused to create a Connect account for ${restaurant.slug} ` +
              `(country ${restaurant.country}): ${err.message}`,
          );
          throw new BadRequestException(`Stripe rejected the setup: ${err.message}`);
        }
        throw err;
      }
      accountId = account.id;

      await this.prisma.restaurant.update({
        where: { id: restaurantId },
        data: { stripeAccountId: accountId },
      });
    }

    const webUrl = this.config.getOrThrow<string>('WEB_URL');

    /**
     * Where Stripe drops them when they finish (or bail).
     *
     * These MUST be real routes. They used to point at /dashboard/settings/payments,
     * which does not exist — so a restaurant completed Stripe's entire onboarding
     * form and was returned to a 404. From their side the product simply broke at
     * the exact moment they handed over their bank details, which is the worst
     * possible moment for it to look broken.
     *
     * /dashboard/setup is the setup checklist: it re-reads Stripe status on load, so
     * they land on a page that shows them the step going green.
     */
    const link = await this.stripe.accountLinks.create({
      account: accountId,
      // Stripe sends them here if the link expires mid-flow; we just mint a new one.
      refresh_url: `${webUrl}/dashboard/setup?stripe=refresh`,
      return_url: `${webUrl}/dashboard/setup?stripe=connected`,
      type: 'account_onboarding',
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'stripe.onboarding_started',
      entityType: 'Restaurant',
      entityId: restaurantId,
    });

    return { url: link.url, accountId };
  }

  /**
   * A login link into the restaurant's own Stripe Express dashboard.
   *
   * "Connected" is not "finished": bank accounts change, cards expire, tax IDs
   * get corrected. All of that lives in Stripe's hosted dashboard for THEIR
   * account -- we just mint the door. Links are single-use and short-lived, so
   * one is created per click, never stored.
   */
  async createExpressDashboardLink(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant?.stripeAccountId) {
      throw new BadRequestException('Connect Stripe first — there is no account to manage yet');
    }
    const link = await this.stripe.accounts.createLoginLink(restaurant.stripeAccountId);
    return { url: link.url };
  }

  /**
   * Pull the live capability status from Stripe. Called when the owner returns
   * from the Connect flow — we don't trust the `?connected=1` query param, we ask
   * Stripe whether they can actually take a card.
   */
  async syncConnectStatus(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant?.stripeAccountId) {
      return { connected: false, chargesEnabled: false, payoutsEnabled: false };
    }

    const account = await this.stripe.accounts.retrieve(restaurant.stripeAccountId);

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
        ...(account.charges_enabled && restaurant.onboardingStep === 'MENU'
          ? { onboardingStep: 'PAYMENTS' }
          : {}),
      },
    });

    return {
      connected: true,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      /** Stripe's list of what it still needs from the owner. Rendered as a checklist. */
      requirementsDue: account.requirements?.currently_due ?? [],
    };
  }

  /**
   * Register a storefront domain with Stripe so Apple Pay works on it.
   *
   * This is the single most commonly-missed step in accepting Apple Pay, and its
   * failure mode is the worst kind: NO ERROR ANYWHERE. The button simply never
   * renders, on every iPhone, forever, and you assume the code is wrong.
   *
   * Every restaurant is its own domain (`joes.dinedirect.manvion.ca`, plus any custom domain
   * they attach later), so every one must be registered individually. Called on
   * publish, and again whenever a custom domain is attached.
   *
   * Idempotent and non-fatal: a restaurant going live must not fail because Stripe's
   * domain endpoint had a bad minute. Apple Pay simply won't show until it succeeds,
   * and the retry happens on the next publish.
   */
  async registerApplePayDomain(domain: string): Promise<boolean> {
    try {
      await this.stripe.applePayDomains.create({ domain_name: domain });
      this.logger.log(`Apple Pay enabled for ${domain}`);
      return true;
    } catch (err) {
      const message = (err as Error).message;

      // Already registered — that's a success, not a failure.
      if (message.includes('already') || message.includes('exists')) return true;

      this.logger.warn(
        `Could not register ${domain} for Apple Pay: ${message}. ` +
          `Apple Pay will not appear on that storefront until this succeeds.`,
      );
      return false;
    }
  }

  // --- Checkout -------------------------------------------------------------

  /**
   * Create a Stripe Checkout Session for an order.
   *
   * The line items are built from the ORDER (which was priced server-side), not
   * from anything the browser sent. Stripe therefore charges exactly what we
   * computed, and the amounts on the Stripe dashboard reconcile with our DB by
   * construction.
   */
  async createCheckoutSession(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { modifiers: true } }, payment: true, restaurant: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.payment) throw new BadRequestException('Order has no payment record');

    if (order.payment.status === 'PAID') {
      throw new BadRequestException('This order has already been paid');
    }
    if (!order.restaurant.stripeChargesEnabled || !order.restaurant.stripeAccountId) {
      throw new BadRequestException('This restaurant cannot accept payments yet');
    }

    // Reuse an existing unexpired session rather than minting a second one — a
    // customer who double-taps "Pay" must not end up with two checkout sessions.
    if (order.payment.stripeCheckoutSessionId) {
      try {
        const existing = await this.stripe.checkout.sessions.retrieve(
          order.payment.stripeCheckoutSessionId,
        );
        if (existing.status === 'open' && existing.url) {
          return { checkoutUrl: existing.url, sessionId: existing.id };
        }
      } catch {
        // Session is gone or unretrievable — fall through and create a new one.
      }
    }

    const currency = order.currency.toLowerCase();

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = order.items.map((item) => {
      const modifierNames = item.modifiers.map((m) => m.name).join(', ');
      const modifiersCents = item.modifiers.reduce((s, m) => s + m.priceCents, 0);
      return {
        quantity: item.quantity,
        price_data: {
          currency,
          unit_amount: item.unitPriceCents + modifiersCents,
          product_data: {
            name: item.name,
            ...(modifierNames ? { description: modifierNames } : {}),
          },
        },
      };
    });

    // Fees, tax and tip ride as their own line items so the customer sees the
    // same breakdown on Stripe's page that they saw in the cart.
    const addFee = (name: string, cents: number) => {
      if (cents > 0) {
        lineItems.push({
          quantity: 1,
          price_data: { currency, unit_amount: cents, product_data: { name } },
        });
      }
    };
    addFee('Service fee', order.serviceFeeCents);
    addFee('Delivery fee', order.deliveryFeeCents);
    addFee('Tax', order.taxCents);
    addFee('Tip', order.tipCents);

    const webUrl = this.config.getOrThrow<string>('WEB_URL');
    // Where the customer lands the moment their card is charged. A dead hostname
    // here is a paid order and a lost customer. See common/tenant-url.ts.
    const storefront = storefrontBaseUrl(this.config, order.restaurant.slug);

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: lineItems,
        customer_email: order.customerEmail,
        client_reference_id: order.id,

        /**
         * PAYMENT METHODS — deliberately NOT listed here.
         *
         * Omitting `payment_method_types` puts Stripe in "dynamic payment methods"
         * mode: it shows whatever is enabled on the connected account's dashboard,
         * filtered by the customer's device, country and the charge currency. That
         * is the modern, recommended path and it is what makes the following work
         * without any code:
         *
         *   APPLE PAY / GOOGLE PAY — there is no `payment_method_types: ['apple_pay']`.
         *   That's a common and expensive misunderstanding: both are ways of
         *   presenting a CARD, and Checkout surfaces them automatically on a device
         *   that supports them.
         *
         *   INDIA (UPI → PhonePe, Google Pay, Paytm) — PhonePe and GPay are not
         *   separate rails, they are UPI apps. Enabling UPI on the Indian connected
         *   account makes a UPI option appear on INR charges, and it opens whichever
         *   app the customer has installed. Hardcoding `['card','upi']` here would
         *   instead BREAK every non-Indian restaurant, because offering UPI on a USD
         *   charge is a hard Stripe error at checkout.
         *
         * THE ONE THING THAT WILL BITE YOU: Apple Pay also requires the DOMAIN to be
         * registered with Stripe. Every restaurant is a different domain, and if it
         * isn't registered the button silently never renders — no error, anywhere.
         * See registerApplePayDomain(), which publish() calls for exactly this reason.
         */


        success_url: `${storefront}/track/${order.trackingToken}?paid=1`,
        cancel_url: `${storefront}/checkout?cancelled=1`,

        // A checkout that sits open forever holds a "pending" order on the
        // restaurant's books. 30 minutes is generous for a food order.
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,

        payment_intent_data: {
          /**
           * Destination charge WITH on_behalf_of: the restaurant is the merchant
           * of record. Three things follow, all of them the right default for a
           * marketplace:
           *
           *  1. STRIPE'S PROCESSING FEE (~2.9% + 30c) is debited from the
           *     RESTAURANT's account, not the platform's. Without this, the
           *     platform paid processing out of its commission -- at 3% commission
           *     vs ~2.9%+30c processing, the platform LOST money on every small
           *     pickup order. Commission is now pure margin.
           *  2. The customer's card statement shows the restaurant's name, which
           *     is who they think they bought from -- fewer "what is this charge"
           *     disputes.
           *  3. Dispute liability sits with the restaurant whose food it was.
           */
          on_behalf_of: order.restaurant.stripeAccountId,
          transfer_data: { destination: order.restaurant.stripeAccountId },
          /**
           * The platform's take on this charge = commission + the courier cost the
           * platform will pay on the restaurant's behalf at dispatch. Folding the
           * courier into the SAME application fee keeps the restaurant's payout
           * equal to the margin analytics shows them (total - commission -
           * courier), with no invoicing loop. NULL courier cost -- pickup, dine-in,
           * self-delivery, or a failed quote -- adds nothing.
           */
          application_fee_amount:
            order.payment.platformFeeCents + (order.payment.courierCostCents ?? 0) > 0
              ? order.payment.platformFeeCents + (order.payment.courierCostCents ?? 0)
              : undefined,
          // Metadata is our lifeline in the webhook: it's how we get from a
          // Stripe event back to an DineDirect order without a lookup table.
          metadata: {
            orderId: order.id,
            orderNumber: order.orderNumber,
            restaurantId: order.restaurantId,
          },
          description: `${order.restaurant.name} order #${order.orderNumber}`,
        },

        metadata: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          restaurantId: order.restaurantId,
        },
      },
      {
        // Idempotency key: retrying this exact call (network blip, user
        // double-click) returns the SAME session instead of creating another.
        idempotencyKey: `checkout:${order.id}`,
      },
    );

    await this.prisma.payment.update({
      where: { id: order.payment.id },
      data: { stripeCheckoutSessionId: session.id },
    });

    return { checkoutUrl: session.url!, sessionId: session.id };
  }

  // --- Webhook --------------------------------------------------------------

  /**
   * Verify a webhook's signature. Stripe signs every event; an unsigned or
   * badly-signed request is an attacker trying to mark an order paid for free,
   * so this is non-negotiable and happens before we parse anything.
   *
   * Requires the RAW body — see main.ts, where JSON parsing is disabled for this
   * route.
   */
  constructEvent(rawBody: Buffer, signature: string): Stripe.Event {
    const secret = this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
    try {
      return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      this.logger.warn(`Rejected webhook with bad signature: ${(err as Error).message}`);
      throw new BadRequestException('Invalid webhook signature');
    }
  }

  /**
   * Process a verified Stripe event, exactly once.
   *
   * Idempotency: we insert the event id into WebhookEvent first. A duplicate
   * delivery (Stripe retries for up to 3 days) hits the unique constraint and we
   * bail out — so a retried `checkout.session.completed` can't mark an order paid
   * twice or send the customer two texts.
   */
  async handleEvent(event: Stripe.Event): Promise<{ handled: boolean }> {
    const alreadySeen = await this.prisma.webhookEvent.findUnique({
      where: { provider_eventId: { provider: 'stripe', eventId: event.id } },
    });
    if (alreadySeen?.processedAt) {
      this.logger.log(`Skipping already-processed Stripe event ${event.id}`);
      return { handled: false };
    }

    const record = await this.prisma.webhookEvent.upsert({
      where: { provider_eventId: { provider: 'stripe', eventId: event.id } },
      create: {
        provider: 'stripe',
        eventId: event.id,
        eventType: event.type,
        payload: event as unknown as object,
        attempts: 1,
      },
      update: { attempts: { increment: 1 } },
    });

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          // ONE event type, two products: a subscription checkout (us billing the
          // restaurant) and an order checkout (a customer paying the restaurant).
          // The mode tells them apart, so an order handler never sees a sub session.
          if (event.data.object.mode === 'subscription') {
            await this.subscriptions.onCheckoutCompleted(event.data.object);
          } else if (event.data.object.metadata?.kind === 'catering') {
            // A catering package paid in full up front. No Order behind it — the
            // money maps to a CateringRequest, marked paid + confirmed here.
            await this.onCateringCheckoutCompleted(event.data.object);
          } else {
            await this.onCheckoutCompleted(event.data.object);
          }
          break;
        case 'checkout.session.expired':
          await this.onCheckoutExpired(event.data.object);
          break;
        case 'payment_intent.payment_failed':
          await this.onPaymentFailed(event.data.object);
          break;
        case 'charge.refunded':
          await this.onChargeRefunded(event.data.object);
          break;
        case 'account.updated':
          await this.onAccountUpdated(event.data.object);
          break;

        // --- Stripe Billing: our subscription revenue -------------------------
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
          await this.subscriptions.onSubscriptionChanged(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await this.subscriptions.onSubscriptionDeleted(event.data.object);
          break;
        case 'invoice.paid':
          await this.subscriptions.onInvoicePaid(event.data.object);
          break;
        case 'invoice.payment_failed':
          await this.subscriptions.onInvoicePaymentFailed(event.data.object);
          break;

        default:
          this.logger.debug(`Ignoring unhandled Stripe event type: ${event.type}`);
      }

      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: { processedAt: new Date(), error: null },
      });
      return { handled: true };
    } catch (err) {
      const message = (err as Error).message;
      await this.prisma.webhookEvent.update({
        where: { id: record.id },
        data: { error: message },
      });
      // Rethrow: a 500 makes Stripe retry, which is what we want for a transient
      // failure (DB down). The idempotency check above makes that retry safe.
      this.logger.error(`Failed to process Stripe event ${event.id}: ${message}`);
      throw err;
    }
  }

  /**
   * Ask Stripe directly whether a checkout session was paid, and apply it if so.
   *
   * Called by the reconciliation sweeper for orders stuck PENDING. Stripe is the
   * source of truth about money — if it says paid and our DB says pending, our DB
   * is wrong and we missed a webhook.
   *
   * Routes through the exact same handler as the webhook, so a recovered order is
   * indistinguishable from a normal one: same notifications, same audit trail. And
   * because that handler is idempotent, a webhook arriving late — after we've
   * already reconciled — is harmless.
   *
   * @returns true if this call actually recovered a paid order.
   */
  async reconcileCheckoutSession(sessionId: string): Promise<boolean> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);

    if (session.payment_status !== 'paid') {
      return false; // genuinely not paid — nothing to recover
    }

    await this.onCheckoutCompleted(session);
    return true;
  }

  // --- Catering package checkout -------------------------------------------
  //
  // A catering package is paid in full, up front, exactly like an order — same
  // destination charge so the restaurant is the merchant of record and takes the
  // Stripe fee — but there is no Order behind it, only a CateringRequest. So it gets
  // its own thin checkout here rather than being forced through the order pipeline.

  /**
   * Start a Stripe Checkout for a catering package request.
   *
   * Returns null (rather than throwing) when the restaurant can't take an online
   * card here — no connected Stripe account, or an India/Razorpay restaurant. The
   * caller degrades gracefully to "request received, the restaurant will arrange
   * payment", so the enquiry is never lost just because online pay isn't wired.
   */
  async createCateringCheckout(requestId: string): Promise<{ checkoutUrl: string } | null> {
    const request = await this.prisma.cateringRequest.findUnique({
      where: { id: requestId },
      include: { restaurant: true },
    });
    if (!request || request.type !== 'PACKAGE' || !request.totalCents) return null;

    const restaurant = request.restaurant;
    // Online card payment here is Stripe-only; a Razorpay (India) restaurant has no
    // connected Stripe account, so we fall back to the request-only path.
    if (usesRazorpay(restaurant.country) || !restaurant.stripeAccountId) return null;

    const storefront = storefrontBaseUrl(this.config, restaurant.slug);
    const commissionBps = effectiveCommissionBps(restaurant);
    const applicationFee = Math.round((request.totalCents * commissionBps) / 10_000);

    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: request.customerEmail,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: restaurant.currency.toLowerCase(),
              unit_amount: request.totalCents,
              product_data: {
                name: `Catering — ${request.packageName}`,
                description: `${request.headCount} people · ${new Date(request.eventDate).toLocaleDateString()}`,
              },
            },
          },
        ],
        payment_intent_data: {
          on_behalf_of: restaurant.stripeAccountId,
          transfer_data: { destination: restaurant.stripeAccountId },
          ...(applicationFee > 0 ? { application_fee_amount: applicationFee } : {}),
          description: `${restaurant.name} catering — ${request.packageName}`,
          metadata: { kind: 'catering', cateringRequestId: request.id, restaurantId: restaurant.id },
        },
        metadata: { kind: 'catering', cateringRequestId: request.id, restaurantId: restaurant.id },
        success_url: `${storefront}/catering?paid=1`,
        cancel_url: `${storefront}/catering?cancelled=1`,
        expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      },
      { idempotencyKey: `catering:${request.id}` },
    );

    if (!session.url) return null;

    await this.prisma.cateringRequest.update({
      where: { id: request.id },
      data: { stripeSessionId: session.id, paymentProvider: 'STRIPE' },
    });

    return { checkoutUrl: session.url };
  }

  private async onCateringCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const requestId = session.metadata?.cateringRequestId;
    if (!requestId) {
      this.logger.error(`catering checkout with no cateringRequestId (session ${session.id})`);
      return;
    }
    if (session.payment_status !== 'paid') return;

    const request = await this.prisma.cateringRequest.findUnique({ where: { id: requestId } });
    if (!request || request.paymentStatus === 'PAID') return; // idempotent

    await this.prisma.cateringRequest.update({
      where: { id: requestId },
      data: { paymentStatus: 'PAID', status: 'CONFIRMED', paidAt: new Date() },
    });

    await this.audit.log({
      restaurantId: request.restaurantId,
      action: 'catering.paid',
      entityType: 'CateringRequest',
      entityId: requestId,
      metadata: { packageName: request.packageName, totalCents: request.totalCents },
    });

    this.logger.log(`Catering request ${requestId} paid (${request.packageName})`);
  }

  private async onCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const orderId = session.metadata?.orderId ?? session.client_reference_id;
    if (!orderId) {
      this.logger.error(`checkout.session.completed with no orderId (session ${session.id})`);
      return;
    }
    if (session.payment_status !== 'paid') {
      this.logger.warn(`Checkout ${session.id} completed but payment_status=${session.payment_status}`);
      return;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      // `items` is loaded because the restaurant's NEW ORDER alert summarises them
      // ("2x Classic, 1x Fries"). Without it the kitchen gets a text telling them
      // an order arrived but not what's in it.
      include: {
        payment: true,
        restaurant: true,
        items: { select: { name: true, quantity: true, productId: true } },
      },
    });
    if (!order?.payment) {
      this.logger.error(`Stripe paid an order we don't have: ${orderId}`);
      return;
    }
    if (order.payment.status === 'PAID') return; // already handled

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id;

    // Pull the charge so we can show "Visa ···4242" in the dashboard.
    let cardBrand: string | null = null;
    let cardLast4: string | null = null;
    let chargeId: string | null = null;

    if (paymentIntentId) {
      try {
        const intent = await this.stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ['latest_charge'],
        });
        const charge = intent.latest_charge as Stripe.Charge | null;
        if (charge) {
          chargeId = charge.id;
          const card = charge.payment_method_details?.card;
          cardBrand = card?.brand ?? null;
          cardLast4 = card?.last4 ?? null;
        }
      } catch (err) {
        // Cosmetic only — never fail a payment over a missing card brand.
        this.logger.warn(`Could not expand charge for ${paymentIntentId}: ${(err as Error).message}`);
      }
    }

    await this.markOrderPaid(orderId, {
      paymentFields: { stripePaymentIntentId: paymentIntentId, stripeChargeId: chargeId },
      cardBrand,
      cardLast4,
      auditMeta: { stripeSessionId: session.id },
    });
  }

  /**
   * The one place an order becomes PAID, whichever provider took the money.
   *
   * Stripe's checkout webhook and Razorpay's payment callback both funnel here, so
   * inventory, loyalty, the audit trail and the "NEW ORDER" notifications happen
   * identically no matter how the customer paid. Idempotent: a second call (a retried
   * webhook) sees status PAID and returns. `paymentFields` carries the provider's own
   * refs (Stripe intent/charge, or Razorpay order/payment ids).
   */
  async markOrderPaid(
    orderId: string,
    opts: {
      paymentFields?: Prisma.PaymentUpdateInput;
      cardBrand?: string | null;
      cardLast4?: string | null;
      auditMeta?: Record<string, unknown>;
    },
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        payment: true,
        restaurant: true,
        items: { select: { name: true, quantity: true, productId: true } },
      },
    });
    if (!order?.payment) {
      this.logger.error(`Payment succeeded for an order we don't have: ${orderId}`);
      return;
    }
    if (order.payment.status === 'PAID') return; // already handled (retried webhook)

    await this.prisma.payment.update({
      where: { id: order.payment.id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        cardBrand: opts.cardBrand ?? null,
        cardLast4: opts.cardLast4 ?? null,
        ...(opts.paymentFields ?? {}),
      },
    });

    // Real money now -- decrement stock and credit loyalty here, not at PENDING
    // creation, so an abandoned checkout never holds either hostage.
    await applyInventoryDelta(this.prisma, order.items, -1);
    await applyLoyaltyDelta(this.prisma, order.customerId, order.loyaltyPointsEarned, 1);

    await this.audit.log({
      restaurantId: order.restaurantId,
      action: 'payment.succeeded',
      entityType: 'Payment',
      entityId: order.payment.id,
      metadata: {
        orderNumber: order.orderNumber,
        amountCents: order.payment.amountCents,
        ...(opts.auditMeta ?? {}),
      },
    });

    this.logger.log(`Order ${order.orderNumber} paid (${order.totalCents} ${order.currency})`);

    // The single most important notification: the customer gets a receipt + tracking
    // link, the restaurant gets "NEW ORDER #..." by SMS and a printable ticket. Fired
    // on payment, never on order creation — an unpaid order isn't an order.
    void this.notifications.onOrderStatus(
      { ...order, items: order.items },
      order.restaurant,
      'PENDING',
    );
  }

  /** Checkout expired unpaid — cancel the order so it doesn't linger on the board. */
  private async onCheckoutExpired(session: Stripe.Checkout.Session): Promise<void> {
    const orderId = session.metadata?.orderId ?? session.client_reference_id;
    if (!orderId) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!order || order.payment?.status === 'PAID' || order.status !== 'PENDING') return;

    await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: 'Checkout expired without payment',
        events: {
          create: { status: 'CANCELLED', source: 'stripe', note: 'Checkout session expired' },
        },
      },
    });
    this.logger.log(`Order ${order.orderNumber} cancelled — checkout expired`);
  }

  private async onPaymentFailed(intent: Stripe.PaymentIntent): Promise<void> {
    const orderId = intent.metadata?.orderId;
    if (!orderId) return;

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payment: true },
    });
    if (!order?.payment || order.payment.status === 'PAID') return;

    await this.prisma.payment.update({
      where: { id: order.payment.id },
      data: {
        status: 'FAILED',
        failureReason: intent.last_payment_error?.message ?? 'Payment failed',
      },
    });

    await this.audit.log({
      restaurantId: order.restaurantId,
      action: 'payment.failed',
      entityType: 'Payment',
      entityId: order.payment.id,
      metadata: { reason: intent.last_payment_error?.code },
    });
  }

  /**
   * Reconcile refunds issued from the Stripe dashboard, not just ours. A
   * restaurant owner who refunds directly in Stripe must still see it reflected
   * here, or the books diverge.
   */
  private async onChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const payment = await this.prisma.payment.findFirst({
      where: { stripeChargeId: charge.id },
      include: { order: true },
    });
    if (!payment) return;

    const refundedCents = charge.amount_refunded;
    const fullyRefunded = refundedCents >= payment.amountCents;

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        refundedAmountCents: refundedCents,
        status: fullyRefunded ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        refundedAt: new Date(),
      },
    });

    await this.audit.log({
      restaurantId: payment.restaurantId,
      action: 'payment.refunded',
      entityType: 'Payment',
      entityId: payment.id,
      metadata: { refundedCents, fullyRefunded, source: 'stripe_webhook' },
    });
  }

  private async onAccountUpdated(account: Stripe.Account): Promise<void> {
    const restaurantId = account.metadata?.restaurantId;
    if (!restaurantId) return;

    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        stripeChargesEnabled: account.charges_enabled,
        stripePayoutsEnabled: account.payouts_enabled,
      },
    });
    this.logger.log(
      `Stripe account for ${restaurantId}: charges=${account.charges_enabled} payouts=${account.payouts_enabled}`,
    );
  }

  // --- Refunds --------------------------------------------------------------

  /**
   * Refund an order, in full or in part. Guards:
   *  - Only a PAID (or partially refunded) order can be refunded.
   *  - The refund cannot exceed what's left un-refunded.
   *  - A full refund also cancels the order, since the customer isn't getting food.
   */
  async refund(restaurantId: string, orderId: string, input: RefundInput, userId?: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: {
        payment: true,
        restaurant: true,
        items: { select: { productId: true, quantity: true } },
      },
    });
    if (!order?.payment) throw new NotFoundException('Order not found');

    const payment = order.payment;
    if (payment.status !== 'PAID' && payment.status !== 'PARTIALLY_REFUNDED') {
      throw new BadRequestException(`Cannot refund a payment that is ${payment.status}`);
    }
    if (!payment.stripePaymentIntentId) {
      throw new BadRequestException('This payment has no Stripe payment intent to refund');
    }

    const remaining = payment.amountCents - payment.refundedAmountCents;
    const amountCents = input.amountCents ?? remaining;

    if (amountCents <= 0) throw new BadRequestException('Refund amount must be positive');
    if (amountCents > remaining) {
      throw new BadRequestException(
        `Only ${(remaining / 100).toFixed(2)} ${payment.currency} remains refundable on this order`,
      );
    }

    /**
     * WHO FUNDS A REFUND -- three parties, three different answers:
     *
     *  1. The restaurant funds the refunded sale (`reverse_transfer: true`).
     *     Without it, Stripe quietly funds refunds from the PLATFORM balance while
     *     the restaurant keeps their payout -- every refund was a direct platform
     *     loss equal to the whole refund. That was the state of this code.
     *
     *  2. The platform returns its COMMISSION proportionally. Keeping a cut of a
     *     sale that unhappened is not a business model.
     *
     *  3. The courier recoup is returned ONLY if no courier was ever dispatched.
     *     Once a courier rode, Uber bills the platform regardless of the refund --
     *     returning the recoup then would make the platform pay for the
     *     restaurant's refunded order's delivery. Not dispatched (cancelled before
     *     READY, or their own driver): the cost never existed, so on a FULL refund
     *     it goes back too.
     *
     * Stripe's `refund_application_fee: true` can't express the split (it returns
     * the whole fee proportionally), so the fee refund is issued manually below.
     */
    const delivery = await this.prisma.delivery.findUnique({
      where: { orderId },
      select: { provider: true, providerDeliveryId: true },
    });
    const courierDispatched = Boolean(
      delivery && delivery.provider !== 'SELF' && delivery.providerDeliveryId,
    );

    const willBeFullRefund = payment.refundedAmountCents + amountCents >= payment.amountCents;
    const commissionShareCents = Math.round(
      (payment.platformFeeCents * amountCents) / payment.amountCents,
    );
    const courierShareCents =
      willBeFullRefund && !courierDispatched ? (payment.courierCostCents ?? 0) : 0;
    const feeRefundCents = commissionShareCents + courierShareCents;

    const stripeRefund = await this.stripe.refunds.create(
      {
        payment_intent: payment.stripePaymentIntentId,
        amount: amountCents,
        reason: 'requested_by_customer',
        // The restaurant's transfer shrinks by the refunded amount. See above.
        reverse_transfer: true,
        refund_application_fee: false,
        metadata: { orderId, restaurantId, note: input.reason ?? '' },
      },
      { idempotencyKey: `refund:${orderId}:${amountCents}:${payment.refundedAmountCents}` },
    );

    if (feeRefundCents > 0) {
      try {
        const intent = await this.stripe.paymentIntents.retrieve(
          payment.stripePaymentIntentId,
          { expand: ['latest_charge'] },
        );
        const charge = intent.latest_charge as Stripe.Charge | null;
        const applicationFeeId =
          typeof charge?.application_fee === 'string'
            ? charge.application_fee
            : charge?.application_fee?.id;

        if (applicationFeeId) {
          await this.stripe.applicationFees.createRefund(
            applicationFeeId,
            { amount: feeRefundCents },
            { idempotencyKey: `feerefund:${orderId}:${feeRefundCents}:${payment.refundedAmountCents}` },
          );
        }
      } catch (err) {
        /**
         * The customer's refund already succeeded; a failed fee refund only means
         * the platform kept money it meant to give back. That is an accounting
         * follow-up, not a reason to fail the request the restaurant is watching.
         */
        this.logger.error(
          `Fee refund of ${feeRefundCents} failed for order ${order.orderNumber} -- ` +
            `platform is holding it: ${(err as Error).message}`,
        );
      }
    }

    const newRefundedTotal = payment.refundedAmountCents + amountCents;
    const isFullRefund = newRefundedTotal >= payment.amountCents;

    await this.prisma.$transaction(async (tx) => {
      await tx.refund.create({
        data: {
          paymentId: payment.id,
          amountCents,
          reason: input.reason,
          stripeRefundId: stripeRefund.id,
          issuedByUserId: userId,
        },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: {
          refundedAmountCents: newRefundedTotal,
          status: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          refundedAt: new Date(),
        },
      });

      if (isFullRefund && order.status !== 'CANCELLED') {
        await tx.order.update({
          where: { id: orderId },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancelReason: input.reason ?? 'Fully refunded',
            events: {
              create: { status: 'CANCELLED', source: 'restaurant', note: 'Order fully refunded' },
            },
          },
        });

        // Stock and loyalty points were only debited/credited when this order
        // was paid -- a full refund means none of it is going out the door,
        // so give both back.
        await applyInventoryDelta(tx, order.items, 1);
        await applyLoyaltyDelta(tx, order.customerId, order.loyaltyPointsEarned, -1);
      }
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'payment.refunded',
      entityType: 'Payment',
      entityId: payment.id,
      metadata: {
        orderNumber: order.orderNumber,
        amountCents,
        isFullRefund,
        reason: input.reason,
        stripeRefundId: stripeRefund.id,
      },
    });

    this.logger.log(
      `Refunded ${amountCents} ${payment.currency} on order ${order.orderNumber}${isFullRefund ? ' (full)' : ' (partial)'}`,
    );

    return {
      refundId: stripeRefund.id,
      amountCents,
      isFullRefund,
      remainingCents: payment.amountCents - newRefundedTotal,
    };
  }
}
