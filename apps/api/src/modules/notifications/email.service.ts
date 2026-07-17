import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { Order, Restaurant } from '@prisma/client';
import { formatMoney, getCountry, planAllows, type PlanTier } from '@dinedirect/shared';
import type { OrderContext } from './templates';
import type { SendResult } from './sms.service';

type OrderWithItems = Order & { items?: Array<{ name: string; quantity: number }> };

/** The minimum an email needs to look like it came from the restaurant. */
interface BrandedRestaurant {
  name: string;
  logoUrl: string | null;
  brandPrimaryColor: string;
  street?: string;
  city?: string;
  phone?: string;
  /**
   * The legal identity behind the brand. A receipt is a tax document, and in Canada,
   * India, the UK and Australia it is not a valid one unless it names the entity that
   * issued it and carries that entity's tax number.
   *
   * Optional because a restaurant below the registration threshold has neither, and
   * because every restaurant that signed up before we asked has neither.
   */
  legalName?: string | null;
  taxId?: string | null;
  country?: string;
  /**
   * Drives whether the "Powered by DineDirect" line shows. A Pro restaurant has the
   * REMOVE_BRANDING capability, so their customer emails carry only THEIR identity —
   * no platform footer. Absent (staff invites, a bare shell) = show it.
   */
  planTier?: PlanTier | null;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend: Resend | null = null;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    this.from = this.config.getOrThrow<string>('RESEND_FROM_EMAIL');

    if (apiKey) {
      this.resend = new Resend(apiKey);
      this.logger.log('Resend email ready');
    } else {
      this.logger.warn('Resend not configured — emails will be logged instead of sent');
    }
  }

  async sendToCustomer(
    template: string,
    order: OrderWithItems,
    restaurant: Restaurant,
    ctx: OrderContext,
  ): Promise<SendResult> {
    const content = this.customerContent(template, order, restaurant, ctx);
    if (!content) return { ok: false, error: `Unknown customer template "${template}"` };

    return this.send({
      to: order.customerEmail,
      subject: content.subject,
      html: this.shell(restaurant, content.body),
      // The customer ordered from the restaurant, so the email is FROM the restaurant.
      fromName: restaurant.name,
      // Replies must reach the restaurant, not our no-reply mailbox. A customer
      // replying "no pickles!" to a receipt is a real thing that happens.
      replyTo: restaurant.email,
    });
  }

  async sendToRestaurant(
    template: string,
    order: OrderWithItems,
    restaurant: Restaurant,
    ctx: OrderContext,
  ): Promise<SendResult> {
    const to = restaurant.notifyEmail ?? restaurant.email;
    const content = this.restaurantContent(template, order, restaurant, ctx);
    if (!content) return { ok: false, error: `Unknown restaurant template "${template}"` };

    return this.send({
      to,
      subject: content.subject,
      html: this.shell(restaurant, content.body),
      fromName: restaurant.name,
      // So the kitchen can just hit reply and talk to the customer.
      replyTo: order.customerEmail,
    });
  }

  // --- Customer templates ----------------------------------------------------

  private customerContent(
    template: string,
    order: OrderWithItems,
    restaurant: Restaurant,
    ctx: OrderContext,
  ): { subject: string; body: string } | null {
    switch (template) {
      case 'receipt':
        return {
          subject: `Your ${restaurant.name} order #${order.orderNumber}`,
          body:
            `<h1 style="margin:0 0 8px;font-size:24px;">Thanks for your order</h1>
             <p style="margin:0 0 4px;color:#64748b;">Order <strong style="color:#0f172a;">#${order.orderNumber}</strong></p>
             <p style="margin:0 0 24px;color:#64748b;">${this.fulfillmentLine(order, restaurant)}</p>` +
            this.receiptTable(order) +
            this.button(ctx.trackingUrl, 'Track your order', restaurant.brandPrimaryColor),
        };

      case 'confirmed': {
        const eta =
          order.fulfillment === 'PICKUP'
            ? `Ready for pickup in about <strong>${restaurant.prepTimeMinutes} minutes</strong>.`
            : order.fulfillment === 'DELIVERY'
              ? `On its way in about <strong>${restaurant.prepTimeMinutes + 15} minutes</strong>.`
              : `Coming to your table in about <strong>${restaurant.prepTimeMinutes} minutes</strong>.`;

        return {
          subject: `${restaurant.name} confirmed order #${order.orderNumber}`,
          body: `<h1 style="margin:0 0 8px;font-size:24px;">Order confirmed</h1>
                 <p style="margin:0 0 24px;color:#64748b;">${this.escape(restaurant.name)} is cooking order
                   <strong style="color:#0f172a;">#${order.orderNumber}</strong> now. ${eta}</p>
                 ${this.button(ctx.trackingUrl, 'Track your order', restaurant.brandPrimaryColor)}`,
        };
      }

      /**
       * The thank-you. The last thing this customer hears from us.
       *
       * It does three jobs, in order: thank them, remind them the money went to
       * the restaurant rather than a marketplace, and make ordering again a single
       * click. That last line is the entire business model of this platform, so it
       * gets a button rather than a footnote.
       */
      case 'thank_you': {
        const storefront = ctx.trackingUrl.split('/track/')[0];
        const delivered = order.fulfillment === 'DELIVERY';

        return {
          subject: `Thanks for ordering from ${restaurant.name}`,
          body: `<h1 style="margin:0 0 8px;font-size:24px;">Thank you${order.customerName ? `, ${this.escape(order.customerName.split(' ')[0])}` : ''}!</h1>
                 <p style="margin:0 0 20px;color:#64748b;">
                   Order <strong style="color:#0f172a;">#${order.orderNumber}</strong> ${
                     delivered ? 'has been delivered' : 'is all done'
                   }. We hope it was worth the wait.
                 </p>

                 <div style="background:#f8fafc;border-radius:12px;padding:20px;margin:0 0 24px;">
                   <p style="margin:0;font-size:14px;color:#475569;line-height:1.6;">
                     You ordered <strong style="color:#0f172a;">directly from ${this.escape(restaurant.name)}</strong> —
                     no marketplace took a cut. That means more of what you paid stayed with the
                     people who cooked your food. Thank you for that.
                   </p>
                 </div>

                 ${this.receiptTable(order)}
                 ${this.button(storefront, 'Order again', restaurant.brandPrimaryColor)}

                 <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;">
                   Something wrong with your order? Call ${this.escape(restaurant.name)} on
                   <a href="tel:${this.escape(restaurant.phone)}" style="color:#475569;">${this.escape(restaurant.phone)}</a> —
                   they'll put it right.
                 </p>`,
        };
      }

      case 'cancelled':
        return {
          subject: `${restaurant.name} order #${order.orderNumber} was cancelled`,
          body: `<h1 style="margin:0 0 8px;font-size:24px;">Order cancelled</h1>
                 <p style="margin:0 0 12px;color:#64748b;">
                   Order <strong style="color:#0f172a;">#${order.orderNumber}</strong> has been cancelled${
                     order.cancelReason ? `: ${this.escape(order.cancelReason)}` : '.'
                   }
                 </p>
                 <p style="margin:0 0 24px;color:#64748b;">
                   Any payment of ${formatMoney(order.totalCents, order.currency)} will be refunded to
                   your original payment method within 5–10 business days.
                 </p>
                 <p style="margin:0;color:#64748b;">
                   Questions? Call ${this.escape(restaurant.name)} on
                   <a href="tel:${this.escape(restaurant.phone)}">${this.escape(restaurant.phone)}</a>.
                 </p>`,
        };

      default:
        return null;
    }
  }

  // --- Restaurant templates --------------------------------------------------

  private restaurantContent(
    template: string,
    order: OrderWithItems,
    restaurant: Restaurant,
    ctx: OrderContext,
  ): { subject: string; body: string } | null {
    const webUrl = this.config.getOrThrow<string>('WEB_URL');

    switch (template) {
      /**
       * The kitchen ticket. Designed to be legible at a glance and printable —
       * a lot of restaurants will literally print this and spike it.
       */
      case 'new_order':
        return {
          subject: `NEW ORDER #${order.orderNumber} — ${formatMoney(order.totalCents, order.currency)}`,
          body: `<div style="background:#0f172a;color:#fff;border-radius:12px;padding:20px;margin:0 0 24px;text-align:center;">
                   <p style="margin:0;font-size:13px;letter-spacing:.1em;opacity:.7;">NEW ORDER</p>
                   <p style="margin:4px 0 0;font-size:32px;font-weight:700;">#${order.orderNumber}</p>
                   <p style="margin:8px 0 0;font-size:15px;">
                     ${this.escape(order.fulfillment.replace('_', '-'))}${
                       order.tableNumber ? ` · TABLE ${this.escape(order.tableNumber)}` : ''
                     }
                   </p>
                 </div>

                 ${this.ticketItems(order)}

                 ${
                   order.notes
                     ? `<div style="background:#fef3c7;border-radius:8px;padding:12px;margin:16px 0;">
                          <p style="margin:0;font-size:14px;color:#78350f;"><strong>Note:</strong> ${this.escape(order.notes)}</p>
                        </div>`
                     : ''
                 }

                 <table width="100%" style="margin-top:16px;font-size:14px;">
                   <tr><td style="color:#64748b;padding:3px 0;">Customer</td><td align="right">${this.escape(order.customerName)}</td></tr>
                   <tr><td style="color:#64748b;padding:3px 0;">Phone</td><td align="right"><a href="tel:${this.escape(order.customerPhone)}">${this.escape(order.customerPhone)}</a></td></tr>
                   ${
                     order.deliveryStreet
                       ? `<tr><td style="color:#64748b;padding:3px 0;">Deliver to</td><td align="right">${this.escape(order.deliveryStreet)}, ${this.escape(order.deliveryCity ?? '')}</td></tr>`
                       : ''
                   }
                   ${
                     order.scheduledFor
                       ? `<tr><td style="color:#64748b;padding:3px 0;">Scheduled</td><td align="right"><strong>${order.scheduledFor.toLocaleString()}</strong></td></tr>`
                       : ''
                   }
                   <tr><td style="color:#64748b;padding:3px 0;border-top:1px solid #e2e8f0;">Paid</td>
                       <td align="right" style="border-top:1px solid #e2e8f0;"><strong>${formatMoney(order.totalCents, order.currency)}</strong></td></tr>
                 </table>

                 ${this.button(`${webUrl}/dashboard/orders`, 'Accept this order', restaurant.brandPrimaryColor)}`,
        };

      /**
       * The loop closing on the restaurant's side. "It's complete, nothing more
       * to do" — which is exactly the reassurance an owner wants at the end of a
       * delivery they never physically saw finish.
       */
      case 'order_complete':
        return {
          subject: `Order #${order.orderNumber} complete — ${formatMoney(order.totalCents, order.currency)}`,
          body: `<div style="background:#ecfdf5;border-radius:12px;padding:20px;margin:0 0 24px;text-align:center;">
                   <p style="margin:0;font-size:15px;color:#065f46;font-weight:600;">
                     ${order.fulfillment === 'DELIVERY' ? 'Delivered' : 'Collected'} · Complete
                   </p>
                   <p style="margin:4px 0 0;font-size:28px;font-weight:700;color:#064e3b;">#${order.orderNumber}</p>
                 </div>

                 <p style="margin:0 0 20px;color:#64748b;">
                   ${
                     order.fulfillment === 'DELIVERY'
                       ? `${this.escape(ctx.courierName ?? 'The driver')} delivered this order to ${this.escape(order.customerName)}.`
                       : `${this.escape(order.customerName)} collected this order.`
                   }
                   Nothing further is needed from you.
                 </p>

                 ${this.receiptTable(order)}

                 <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;">
                   Payment settles to your Stripe account on your normal payout schedule.
                 </p>`,
        };

      default:
        return null;
    }
  }

  /**
   * Send arbitrary body HTML inside the standard branded shell.
   *
   * For messages that aren't about an order — staff invitations, and whatever else
   * comes later. Everything the platform sends should look like it came from the
   * same company, so nothing gets to bypass the shell.
   */
  async sendRaw(params: {
    to: string;
    subject: string;
    body: string;
    restaurant: BrandedRestaurant;
    replyTo?: string;
  }): Promise<SendResult> {
    return this.send({
      to: params.to,
      subject: params.subject,
      html: this.shell(params.restaurant, params.body),
      replyTo: params.replyTo,
    });
  }

  // --- Rendering helpers -----------------------------------------------------

  private receiptTable(order: OrderWithItems): string {
    const row = (label: string, cents: number, bold = false) => `
      <tr>
        <td style="padding:4px 0;color:${bold ? '#0f172a' : '#64748b'};font-weight:${bold ? 600 : 400};">${label}</td>
        <td align="right" style="padding:4px 0;color:${bold ? '#0f172a' : '#64748b'};font-weight:${bold ? 600 : 400};">
          ${formatMoney(cents, order.currency)}
        </td>
      </tr>`;

    return `<table width="100%" style="border-top:1px solid #e2e8f0;margin-top:8px;padding-top:12px;font-size:14px;">
      ${row('Subtotal', order.subtotalCents)}
      ${order.discountCents > 0 ? row('Discount', -order.discountCents) : ''}
      ${order.serviceFeeCents > 0 ? row('Service fee', order.serviceFeeCents) : ''}
      ${order.deliveryFeeCents > 0 ? row('Delivery', order.deliveryFeeCents) : ''}
      ${this.taxRows(order, row)}
      ${order.tipCents > 0 ? row('Tip', order.tipCents) : ''}
      ${row('Total', order.totalCents, true)}
    </table>`;
  }

  /**
   * Tax, itemised under the names the law uses.
   *
   * A Quebec receipt showing "Tax 14.975%" instead of naming GST and QST
   * separately is not a valid receipt. Nor is an Indian one that doesn't show CGST
   * and SGST as distinct lines. So we print whatever `taxLines` was frozen with at
   * checkout — never a recomputed or collapsed figure.
   *
   * Falls back to a single "Tax" line for orders placed before tax components
   * existed, and for the simple single-rate US case.
   */
  private taxRows(
    order: OrderWithItems,
    row: (label: string, cents: number, bold?: boolean) => string,
  ): string {
    const lines = order.taxLines as Array<{ name: string; amountCents: number }> | null;

    if (lines?.length) {
      return lines.map((t) => row(this.escape(t.name), t.amountCents)).join('');
    }
    return row('Tax', order.taxCents);
  }

  /** Big, legible line items for the kitchen ticket. */
  private ticketItems(order: OrderWithItems): string {
    const items = order.items ?? [];
    if (items.length === 0) return '';

    return `<table width="100%" style="font-size:16px;">
      ${items
        .map(
          (item) => `<tr>
            <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;">
              <strong style="font-size:18px;">${item.quantity} ×</strong>
              <span style="margin-left:6px;">${this.escape(item.name)}</span>
            </td>
          </tr>`,
        )
        .join('')}
    </table>`;
  }

  private fulfillmentLine(order: Order, restaurant: Restaurant): string {
    if (order.fulfillment === 'DELIVERY') {
      return `Delivering to ${this.escape(order.deliveryStreet ?? '')}, ${this.escape(order.deliveryCity ?? '')}`;
    }
    if (order.fulfillment === 'PICKUP') {
      return `Pickup from ${this.escape(restaurant.street)}, ${this.escape(restaurant.city)}`;
    }
    return `Dine in${order.tableNumber ? ` — table ${this.escape(order.tableNumber)}` : ''}`;
  }

  /**
   * Compose the From header so the customer's inbox shows the RESTAURANT's name, not
   * our platform address. The sending address stays our verified Resend domain (we
   * can't verify a fresh domain per restaurant), but "Joe's Diner <orders@…>" reads
   * as the restaurant, which is who the customer thinks they ordered from.
   */
  private fromWithName(name?: string): string {
    if (!name) return this.from;
    // this.from is either "addr" or "Existing Name <addr>"; keep only the address.
    const address = this.from.match(/<([^>]+)>/)?.[1] ?? this.from;
    // Strip anything that could break or inject into the header.
    const clean = name.replace(/["<>\r\n]/g, '').trim();
    return clean ? `${clean} <${address}>` : this.from;
  }

  private async send(params: {
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
    /** Display name for the From header — the restaurant, on customer-facing mail. */
    fromName?: string;
  }): Promise<SendResult> {
    if (!this.resend) {
      this.logger.log(`[Email stub] -> ${params.to}: ${params.subject}`);
      return { ok: false, error: 'Resend not configured (development stub)' };
    }

    try {
      const result = await this.resend.emails.send({
        from: this.fromWithName(params.fromName),
        to: params.to,
        subject: params.subject,
        html: params.html,
        replyTo: params.replyTo,
      });
      this.logger.log(`Email sent: "${params.subject}"`);
      return { ok: true, id: result.data?.id };
    } catch (err) {
      const error = (err as Error).message;
      this.logger.error(`Email send failed: ${error}`);
      return { ok: false, error };
    }
  }

  /**
   * The shell only needs branding. Typed as its own minimal shape rather than a
   * full Restaurant, so callers that legitimately have only a name and a logo (a
   * staff invite) don't have to lie about it with a cast — and so the footer knows
   * to omit an address it wasn't given.
   */
  /**
   * The legal footer: who issued this, and under what tax number.
   *
   * Printed only when we actually have it — a receipt claiming a blank GSTIN is worse
   * than one that stays quiet. The label comes from the country, because "Tax ID: …"
   * is not a phrase that appears on any Indian or Canadian invoice; it says GSTIN, or
   * it says GST/HST No.
   *
   * Deliberately in the footer of EVERY email rather than only the receipt: the
   * confirmation and the thank-you are also documents a customer forwards to their
   * accountant, and they are cheaper to make valid than to explain.
   */
  private legalIdentity(restaurant: BrandedRestaurant): string {
    const lines: string[] = [];

    // Only worth naming the entity when it differs from the trading name — otherwise
    // it just prints the restaurant's name twice.
    if (restaurant.legalName && restaurant.legalName !== restaurant.name) {
      lines.push(this.escape(restaurant.legalName));
    }

    // Print the tax number only where the receipt needs it to be legal. A US EIN is
    // collected for the restaurant's own accountant and must NOT be broadcast to
    // every customer — that is their federal ID, not a line item.
    const spec = getCountry(restaurant.country ?? 'US').taxId;
    if (restaurant.taxId && spec.requiredOnReceipt) {
      lines.push(`${this.escape(spec.label)}: ${this.escape(restaurant.taxId)}`);
    }

    return lines.length ? `<br />${lines.join(' · ')}` : '';
  }

  private shell(restaurant: BrandedRestaurant, content: string): string {
    return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
      <tr><td align="center">
        <table width="100%" style="max-width:540px;background:#ffffff;border-radius:16px;padding:36px;box-shadow:0 1px 3px rgba(0,0,0,.06);">
          <tr><td>
            ${
              restaurant.logoUrl
                ? `<img src="${this.escape(restaurant.logoUrl)}" alt="${this.escape(restaurant.name)}" height="40" style="margin-bottom:28px;border-radius:8px;" />`
                : `<div style="font-size:17px;font-weight:700;margin-bottom:28px;color:#0f172a;letter-spacing:-.01em;">${this.escape(restaurant.name)}</div>`
            }
            ${content}
            <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0 16px;" />
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
              ${this.escape(restaurant.name)}${
                restaurant.street && restaurant.city
                  ? ` · ${this.escape(restaurant.street)}, ${this.escape(restaurant.city)}`
                  : ''
              }
              ${restaurant.phone ? `<br />${this.escape(restaurant.phone)}` : ''}
              ${this.legalIdentity(restaurant)}
            </p>
            ${
              restaurant.planTier && planAllows(restaurant.planTier, 'REMOVE_BRANDING')
                ? ''
                : `<p style="margin:10px 0 0;font-size:11px;color:#cbd5e1;">Powered by DineDirect</p>`
            }
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  }

  private button(url: string, label: string, color: string): string {
    return `<div style="margin-top:24px;">
      <a href="${this.escape(url)}"
         style="display:inline-block;background:${this.escape(color)};color:#ffffff;text-decoration:none;
                padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">${this.escape(label)}</a>
    </div>`;
  }

  /** Restaurant names, notes and addresses are user input and land in HTML. */
  private escape(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
