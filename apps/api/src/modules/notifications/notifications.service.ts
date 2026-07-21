import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  NotificationAudience,
  NotificationChannel,
  Order,
  OrderStatus,
  Restaurant,
} from '@prisma/client';
import { formatMoney } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { storefrontBaseUrl } from '../../common/tenant-url';
import { EmailService } from './email.service';
import { SmsService } from './sms.service';
import {
  customerEmailTemplate,
  customerSms,
  restaurantSms,
  summariseItems,
  type OrderContext,
} from './templates';

type OrderWithItems = Order & {
  items?: Array<{ name: string; quantity: number }>;
  delivery?: {
    trackingUrl: string | null;
    courierName: string | null;
    dropoffEta: Date | null;
  } | null;
};

/**
 * The language the CUSTOMER hears back in: what they ordered in (stored on the
 * order), falling back to the restaurant's own content language for older orders or
 * a single-language storefront.
 */
function customerLocale(order: OrderWithItems, restaurant: Restaurant): 'en' | 'fr' {
  if (order.locale === 'fr') return 'fr';
  if (order.locale === 'en') return 'en';
  return restaurant.menuLanguage === 'FR' ? 'fr' : 'en';
}

/** The language the RESTAURANT's own alerts go out in — their content language. */
function restaurantLocale(restaurant: Restaurant): 'en' | 'fr' {
  return restaurant.menuLanguage === 'FR' ? 'fr' : 'en';
}

/**
 * The notification engine.
 *
 * Fans every order event out to BOTH audiences — the customer and the restaurant —
 * over SMS and email, honouring opt-outs, and logging every attempt.
 *
 * Three rules, learned the hard way:
 *
 *  1. NEVER THROW. A Twilio outage must not roll back a kitchen state change. Every
 *     send is best-effort; failures are logged to NotificationLog and to the app log,
 *     never propagated. The kitchen's reality does not depend on Twilio being up.
 *
 *  2. A STOP IS ABSOLUTE. If a customer replied STOP we send them no SMS at all,
 *     including transactional order updates. Honouring a STOP only for marketing is
 *     how a Twilio number gets blocked by carriers. They still get email, and the
 *     tracking link still works.
 *
 *  3. SILENCE IS A BUG. Every attempt — including the ones we deliberately skip —
 *     is written to NotificationLog, because "the customer says they never got the
 *     text" is the most common support ticket in this industry and a shrug is not
 *     an answer.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The single entry point. Every order status change comes through here, and this
   * decides who hears about it and how.
   */
  async onOrderStatus(
    order: OrderWithItems,
    restaurant: Restaurant,
    status: OrderStatus,
  ): Promise<void> {
    const ctx = await this.buildContext(order, restaurant);

    // Run all four channels concurrently, and — critically — allSettled, so one
    // failing provider cannot prevent the other three from delivering.
    await Promise.allSettled([
      this.sendCustomerSms(order, restaurant, status, ctx),
      this.sendCustomerEmail(order, restaurant, status, ctx),
      this.sendRestaurantSms(order, restaurant, status, ctx),
      this.sendRestaurantEmail(order, restaurant, status, ctx),
    ]);
  }

  /**
   * Text and/or email a customer a link to pay for a staff-created (phone) order.
   *
   * Best-effort per channel — a failed SMS must not lose the order or the link (the
   * POS shows it too, for staff to read out). Every attempt is logged, like the rest.
   */
  async sendPaymentLink(order: OrderWithItems, restaurant: Restaurant, url: string): Promise<void> {
    const amount = formatMoney(order.totalCents, order.currency);
    const tasks: Promise<void>[] = [];

    const phone = order.customerPhone;
    if (phone) {
      const body = `${restaurant.name}: order #${order.orderNumber} for ${amount} is ready to pay. Pay securely here: ${url}`;
      tasks.push(
        this.sms.send(phone, body).then((r) =>
          this.log({
            restaurantId: restaurant.id,
            orderId: order.id,
            channel: 'SMS',
            audience: 'CUSTOMER',
            status: r.ok ? 'SENT' : 'FAILED',
            template: 'order.payment_link',
            recipient: phone,
            providerId: r.id,
            error: r.error,
          }),
        ),
      );
    }

    const emailTo = order.customerEmail;
    if (emailTo) {
      const body = `
        <p style="font-size:16px;">Your order <strong>#${order.orderNumber}</strong> is ready to pay.</p>
        <p style="font-size:16px;">Amount due: <strong>${amount}</strong></p>
        <p style="margin:24px 0;">
          <a href="${url}" style="background:#111827;color:#ffffff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;">Pay now</a>
        </p>
        <p style="font-size:13px;color:#64748b;">Or open this link: <a href="${url}">${url}</a></p>`;
      tasks.push(
        this.email
          .sendRaw({
            to: emailTo,
            subject: `Pay for your ${restaurant.name} order #${order.orderNumber}`,
            body,
            restaurant,
          })
          .then((r) =>
            this.log({
              restaurantId: restaurant.id,
              orderId: order.id,
              channel: 'EMAIL',
              audience: 'CUSTOMER',
              status: r.ok ? 'SENT' : 'FAILED',
              template: 'order.payment_link',
              recipient: emailTo,
              providerId: r.id,
              error: r.error,
            }),
          ),
      );
    }

    await Promise.allSettled(tasks);
  }

  // --- Customer --------------------------------------------------------------

  private async sendCustomerSms(
    order: OrderWithItems,
    restaurant: Restaurant,
    status: OrderStatus,
    ctx: OrderContext,
  ): Promise<void> {
    const body = customerSms(status, ctx, customerLocale(order, restaurant));
    if (!body) return; // this status doesn't earn an interruption

    const template = `order.${status.toLowerCase()}`;

    // The STOP check. Deliberately before any provider call.
    const customer = order.customerId
      ? await this.prisma.customer.findUnique({
          where: { id: order.customerId },
          select: { smsOptOut: true },
        })
      : null;

    if (customer?.smsOptOut) {
      await this.log({
        restaurantId: restaurant.id,
        orderId: order.id,
        channel: 'SMS',
        audience: 'CUSTOMER',
        status: 'SKIPPED',
        template,
        recipient: order.customerPhone,
        error: 'Customer replied STOP',
      });
      return;
    }

    const result = await this.sms.send(order.customerPhone, body);
    await this.log({
      restaurantId: restaurant.id,
      orderId: order.id,
      channel: 'SMS',
      audience: 'CUSTOMER',
      status: result.ok ? 'SENT' : 'FAILED',
      template,
      recipient: order.customerPhone,
      providerId: result.id,
      error: result.error,
    });
  }

  private async sendCustomerEmail(
    order: OrderWithItems,
    restaurant: Restaurant,
    status: OrderStatus,
    ctx: OrderContext,
  ): Promise<void> {
    const template = customerEmailTemplate(status);
    if (!template) return;

    const result = await this.email.sendToCustomer(
      template,
      order,
      restaurant,
      ctx,
      customerLocale(order, restaurant),
    );

    await this.log({
      restaurantId: restaurant.id,
      orderId: order.id,
      channel: 'EMAIL',
      audience: 'CUSTOMER',
      status: result.ok ? 'SENT' : 'FAILED',
      template: `order.${template}`,
      recipient: order.customerEmail,
      providerId: result.id,
      error: result.error,
    });
  }

  // --- Restaurant ------------------------------------------------------------

  private async sendRestaurantSms(
    order: OrderWithItems,
    restaurant: Restaurant,
    status: OrderStatus,
    ctx: OrderContext,
  ): Promise<void> {
    const body = restaurantSms(status, ctx, restaurantLocale(restaurant));
    if (!body) return;

    // The number that gets woken up is the ops number, not the one on the website.
    const to = restaurant.notifyPhone ?? restaurant.phone;
    const template = `restaurant.${status.toLowerCase()}`;

    if (!restaurant.notifySmsEnabled) {
      await this.log({
        restaurantId: restaurant.id,
        orderId: order.id,
        channel: 'SMS',
        audience: 'RESTAURANT',
        status: 'SKIPPED',
        template,
        recipient: to,
        error: 'Restaurant has SMS alerts turned off',
      });
      return;
    }

    const result = await this.sms.send(to, body);
    await this.log({
      restaurantId: restaurant.id,
      orderId: order.id,
      channel: 'SMS',
      audience: 'RESTAURANT',
      status: result.ok ? 'SENT' : 'FAILED',
      template,
      recipient: to,
      providerId: result.id,
      error: result.error,
    });
  }

  private async sendRestaurantEmail(
    order: OrderWithItems,
    restaurant: Restaurant,
    status: OrderStatus,
    ctx: OrderContext,
  ): Promise<void> {
    // Email the restaurant only at the two moments that matter: a new order came
    // in (a printable ticket), and the order is complete (the receipt for it).
    const template =
      status === 'PENDING'
        ? 'new_order'
        : status === 'DELIVERED' || status === 'COMPLETED'
          ? 'order_complete'
          : null;

    if (!template || !restaurant.notifyEmailEnabled) return;

    // COMPLETED for a delivery order would double up with DELIVERED.
    if (status === 'COMPLETED' && order.fulfillment === 'DELIVERY') return;

    const to = restaurant.notifyEmail ?? restaurant.email;
    const result = await this.email.sendToRestaurant(template, order, restaurant, ctx);

    await this.log({
      restaurantId: restaurant.id,
      orderId: order.id,
      channel: 'EMAIL',
      audience: 'RESTAURANT',
      status: result.ok ? 'SENT' : 'FAILED',
      template: `restaurant.${template}`,
      recipient: to,
      providerId: result.id,
      error: result.error,
    });
  }

  // --- Inbound SMS (STOP / START) -------------------------------------------

  /**
   * Twilio posts here when a customer replies to one of our texts.
   *
   * Handling STOP is not optional politeness — US carriers require it, and Twilio
   * will suspend a number that ignores it. We honour it across every restaurant on
   * the platform for that number, because the human holding the phone does not
   * care about our tenancy model; they said stop, so we stop.
   */
  async handleInboundSms(from: string, body: string): Promise<{ reply: string | null }> {
    const keyword = body.trim().toUpperCase();

    const STOP_WORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
    const START_WORDS = ['START', 'YES', 'UNSTOP'];

    if (STOP_WORDS.includes(keyword)) {
      const { count } = await this.prisma.customer.updateMany({
        where: { phone: from },
        data: { smsOptOut: true, smsOptOutAt: new Date() },
      });
      this.logger.log(`SMS opt-out honoured for ${this.mask(from)} (${count} customer record(s))`);

      // Twilio's own STOP handling already sends the carrier-mandated confirmation,
      // so replying again would double-text someone who just asked us to stop.
      return { reply: null };
    }

    if (START_WORDS.includes(keyword)) {
      await this.prisma.customer.updateMany({
        where: { phone: from },
        data: { smsOptOut: false, smsOptOutAt: null },
      });
      this.logger.log(`SMS opt-in restored for ${this.mask(from)}`);
      return { reply: 'You will now receive order updates again.' };
    }

    // Anything else is a human trying to talk to the restaurant. We are not a
    // support desk and must not pretend to be one — point them at the restaurant.
    return {
      reply: 'This number is not monitored. Please call the restaurant directly for help with your order.',
    };
  }

  // --- Support surface -------------------------------------------------------

  /** "Did the customer get their texts?" — answerable, at last. */
  async listForOrder(restaurantId: string, orderId: string) {
    return this.prisma.notificationLog.findMany({
      where: { restaurantId, orderId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- Internals -------------------------------------------------------------

  private async buildContext(
    order: OrderWithItems,
    restaurant: Restaurant,
  ): Promise<OrderContext> {
    const items =
      order.items ??
      (await this.prisma.orderItem.findMany({
        where: { orderId: order.id },
        select: { name: true, quantity: true },
      }));

    const delivery =
      order.delivery ??
      (await this.prisma.delivery.findUnique({
        where: { orderId: order.id },
        select: { trackingUrl: true, courierName: true, dropoffEta: true },
      }));

    const etaMinutes = delivery?.dropoffEta
      ? Math.max(1, Math.round((delivery.dropoffEta.getTime() - Date.now()) / 60_000))
      : null;

    return {
      orderNumber: order.orderNumber,
      customerName: order.customerName,
      restaurantName: restaurant.name,
      restaurantPhone: restaurant.phone,
      fulfillment: order.fulfillment,
      totalCents: order.totalCents,
      currency: order.currency,
      trackingUrl: this.trackingUrl(order, restaurant),
      prepTimeMinutes: restaurant.prepTimeMinutes,
      tableNumber: order.tableNumber,
      courierTrackingUrl: delivery?.trackingUrl ?? null,
      courierName: delivery?.courierName ?? null,
      etaMinutes,
      itemSummary: summariseItems(items),
      cancelReason: order.cancelReason,
    };
  }

  private async log(entry: {
    restaurantId: string;
    orderId?: string;
    channel: NotificationChannel;
    audience: NotificationAudience;
    status: 'SENT' | 'FAILED' | 'SKIPPED';
    template: string;
    recipient: string;
    providerId?: string;
    error?: string;
  }): Promise<void> {
    try {
      await this.prisma.notificationLog.create({
        data: {
          restaurantId: entry.restaurantId,
          orderId: entry.orderId,
          channel: entry.channel,
          audience: entry.audience,
          status: entry.status,
          template: entry.template,
          // Never store a full phone number or email. This table is a breach
          // surface, and a masked value answers every support question anyway.
          recipient: this.mask(entry.recipient),
          providerId: entry.providerId,
          error: entry.error?.slice(0, 500),
        },
      });
    } catch (err) {
      // A failed log must not fail the send it was describing.
      this.logger.error(`Could not write notification log: ${(err as Error).message}`);
    }
  }

  private mask(recipient: string): string {
    if (recipient.includes('@')) {
      const [user, domain] = recipient.split('@');
      return `${user.slice(0, 2)}***@${domain}`;
    }
    return recipient.length > 4 ? `***${recipient.slice(-4)}` : '***';
  }

  private trackingUrl(order: Order, restaurant: Restaurant): string {
    // The link a customer taps from their SMS/email. See common/tenant-url.ts.
    const base = storefrontBaseUrl(this.config, restaurant.slug);
    return `${base}/track/${order.trackingToken}`;
  }
}
