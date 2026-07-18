import { formatMoney, type OrderStatus } from '@dinedirect/shared';

/**
 * Every message the platform sends, in one file.
 *
 * Kept together deliberately: the tone of these is the product, as far as a
 * customer is concerned. They are the only thing most customers will ever read
 * from us, and scattering them across services is how you end up with three
 * different voices and a text that says "Order state transitioned to READY".
 *
 * Rules the templates follow:
 *  - Say what happened, then what happens next. Never make someone infer.
 *  - Lead with the restaurant's name, not ours. The customer bought from THEM.
 *  - Every SMS carries the tracking link. It's the only thing they can act on.
 *  - Under 160 characters where we can — a longer SMS costs the restaurant twice.
 */

export interface OrderContext {
  orderNumber: string;
  customerName: string;
  restaurantName: string;
  restaurantPhone: string;
  fulfillment: 'PICKUP' | 'DELIVERY' | 'DINE_IN';
  totalCents: number;
  currency: string;
  trackingUrl: string;
  prepTimeMinutes: number;
  tableNumber?: string | null;
  /** Uber's own live map, once a courier is assigned. */
  courierTrackingUrl?: string | null;
  courierName?: string | null;
  etaMinutes?: number | null;
  itemSummary: string;
  cancelReason?: string | null;
}

// ---------------------------------------------------------------------------
// Customer SMS
// ---------------------------------------------------------------------------

/**
 * Not every status deserves a text.
 *
 * PREPARING is noise — the customer already knows you accepted it and they can
 * see the tracker. Texting on every state change trains people to ignore you,
 * and the one message that matters (READY / driver on the way) gets lost. So this
 * returns null for the states that don't earn an interruption.
 */
export type MessageLocale = 'en' | 'fr';

/** The customer's SMS, in the language they ordered in. */
export function customerSms(
  status: OrderStatus,
  ctx: OrderContext,
  locale: MessageLocale = 'en',
): string | null {
  return locale === 'fr' ? customerSmsFr(status, ctx) : customerSmsEn(status, ctx);
}

function customerSmsEn(status: OrderStatus, ctx: OrderContext): string | null {
  switch (status) {
    case 'PENDING':
      // Sent on payment, not on order creation — an unpaid order isn't an order.
      return `${ctx.restaurantName}: we've got order #${ctx.orderNumber} (${formatMoney(
        ctx.totalCents,
        ctx.currency,
      )}). We'll text you when the kitchen confirms it. Track: ${ctx.trackingUrl}`;

    case 'ACCEPTED':
      return ctx.fulfillment === 'DELIVERY'
        ? `${ctx.restaurantName}: order #${ctx.orderNumber} is confirmed. Cooking now — about ${ctx.prepTimeMinutes} min, then a driver collects it. ${ctx.trackingUrl}`
        : `${ctx.restaurantName}: order #${ctx.orderNumber} is confirmed and cooking. Ready in about ${ctx.prepTimeMinutes} min. ${ctx.trackingUrl}`;

    case 'READY':
      if (ctx.fulfillment === 'PICKUP') {
        const shortId = ctx.orderNumber.slice(-3);
        return `${ctx.restaurantName}: order #${ctx.orderNumber} is READY. Give code ${shortId} at the counter — see you soon!`;
      }
      if (ctx.fulfillment === 'DINE_IN') {
        return `${ctx.restaurantName}: order #${ctx.orderNumber} is on its way to your table.`;
      }
      return `${ctx.restaurantName}: order #${ctx.orderNumber} is packed and we're getting a driver now. ${ctx.trackingUrl}`;

    case 'DRIVER_ASSIGNED': {
      const who = ctx.courierName ? `${ctx.courierName} is` : 'A driver is';
      const link = ctx.courierTrackingUrl ?? ctx.trackingUrl;
      return `${ctx.restaurantName}: ${who} picking up order #${ctx.orderNumber} now. Follow them live: ${link}`;
    }

    case 'OUT_FOR_DELIVERY': {
      const eta = ctx.etaMinutes ? ` Arriving in about ${ctx.etaMinutes} min.` : '';
      const link = ctx.courierTrackingUrl ?? ctx.trackingUrl;
      return `${ctx.restaurantName}: order #${ctx.orderNumber} is on its way to you!${eta} ${link}`;
    }

    case 'DELIVERED':
      return `${ctx.restaurantName}: your order has been delivered — enjoy! Thank you for ordering directly with us. ${ctx.trackingUrl}`;

    case 'COMPLETED':
      return ctx.fulfillment === 'DELIVERY'
        ? null
        : `${ctx.restaurantName}: thanks for your order! We hope it was great. Order directly with us again any time.`;

    case 'CANCELLED':
      return `${ctx.restaurantName}: order #${ctx.orderNumber} has been cancelled${
        ctx.cancelReason ? ` — ${ctx.cancelReason}` : ''
      }. Any payment is refunded within 5-10 business days. Questions: ${ctx.restaurantPhone}`;

    case 'PREPARING':
      return null; // covered by ACCEPTED; a second text here is noise

    default:
      return null;
  }
}

function customerSmsFr(status: OrderStatus, ctx: OrderContext): string | null {
  switch (status) {
    case 'PENDING':
      return `${ctx.restaurantName} : nous avons votre commande #${ctx.orderNumber} (${formatMoney(
        ctx.totalCents,
        ctx.currency,
      )}). Nous vous écrirons quand la cuisine la confirmera. Suivi : ${ctx.trackingUrl}`;

    case 'ACCEPTED':
      return ctx.fulfillment === 'DELIVERY'
        ? `${ctx.restaurantName} : commande #${ctx.orderNumber} confirmée. En préparation — environ ${ctx.prepTimeMinutes} min, puis un livreur la récupère. ${ctx.trackingUrl}`
        : `${ctx.restaurantName} : commande #${ctx.orderNumber} confirmée et en préparation. Prête dans environ ${ctx.prepTimeMinutes} min. ${ctx.trackingUrl}`;

    case 'READY':
      if (ctx.fulfillment === 'PICKUP') {
        const shortId = ctx.orderNumber.slice(-3);
        return `${ctx.restaurantName} : commande #${ctx.orderNumber} PRÊTE. Donnez le code ${shortId} au comptoir — à bientôt !`;
      }
      if (ctx.fulfillment === 'DINE_IN') {
        return `${ctx.restaurantName} : commande #${ctx.orderNumber} arrive à votre table.`;
      }
      return `${ctx.restaurantName} : commande #${ctx.orderNumber} emballée, nous cherchons un livreur. ${ctx.trackingUrl}`;

    case 'DRIVER_ASSIGNED': {
      const who = ctx.courierName ?? 'Un livreur';
      const link = ctx.courierTrackingUrl ?? ctx.trackingUrl;
      return `${ctx.restaurantName} : ${who} récupère la commande #${ctx.orderNumber}. Suivez en direct : ${link}`;
    }

    case 'OUT_FOR_DELIVERY': {
      const eta = ctx.etaMinutes ? ` Arrivée dans environ ${ctx.etaMinutes} min.` : '';
      const link = ctx.courierTrackingUrl ?? ctx.trackingUrl;
      return `${ctx.restaurantName} : commande #${ctx.orderNumber} en route vers vous !${eta} ${link}`;
    }

    case 'DELIVERED':
      return `${ctx.restaurantName} : votre commande a été livrée — bon appétit ! Merci d'avoir commandé directement avec nous. ${ctx.trackingUrl}`;

    case 'COMPLETED':
      return ctx.fulfillment === 'DELIVERY'
        ? null
        : `${ctx.restaurantName} : merci pour votre commande ! Nous espérons qu'elle était excellente. Commandez de nouveau directement quand vous voulez.`;

    case 'CANCELLED':
      return `${ctx.restaurantName} : commande #${ctx.orderNumber} annulée${
        ctx.cancelReason ? ` — ${ctx.cancelReason}` : ''
      }. Tout paiement est remboursé sous 5 à 10 jours ouvrables. Questions : ${ctx.restaurantPhone}`;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Restaurant SMS
// ---------------------------------------------------------------------------

/**
 * What the RESTAURANT gets. This barely existed before, which was the biggest
 * hole in the product: a restaurant whose staff aren't staring at the dashboard
 * had no idea an order had arrived.
 *
 * The kitchen needs different things than the customer:
 *  - A NEW ORDER is an interruption that must be impossible to miss.
 *  - A DELIVERED order is a receipt: the job is done, close the ticket.
 *  - They do NOT need to be told about their own actions (they pressed Accept;
 *    texting them "you accepted" is absurd).
 */
/** What the RESTAURANT gets, in the restaurant's own content language. */
export function restaurantSms(
  status: OrderStatus,
  ctx: OrderContext,
  locale: MessageLocale = 'en',
): string | null {
  return locale === 'fr' ? restaurantSmsFr(status, ctx) : restaurantSmsEn(status, ctx);
}

function restaurantSmsEn(status: OrderStatus, ctx: OrderContext): string | null {
  switch (status) {
    case 'PENDING':
      // Fired on payment. The one message that must always land.
      return `NEW ORDER #${ctx.orderNumber} — ${ctx.fulfillment.replace('_', '-').toLowerCase()}${
        ctx.tableNumber ? ` (table ${ctx.tableNumber})` : ''
      }. ${ctx.itemSummary}. ${formatMoney(ctx.totalCents, ctx.currency)}. Accept it in your dashboard.`;

    case 'DRIVER_ASSIGNED':
      return `Order #${ctx.orderNumber}: ${ctx.courierName ?? 'a driver'} is on the way to collect. Have it bagged and ready.`;

    case 'DELIVERED':
      return `Order #${ctx.orderNumber} DELIVERED to ${ctx.customerName}. ${formatMoney(
        ctx.totalCents,
        ctx.currency,
      )} — complete. Nothing more to do.`;

    case 'COMPLETED':
      return ctx.fulfillment === 'DELIVERY'
        ? null // already told them on DELIVERED
        : `Order #${ctx.orderNumber} collected by ${ctx.customerName}. ${formatMoney(
            ctx.totalCents,
            ctx.currency,
          )} — complete.`;

    case 'CANCELLED':
      return `Order #${ctx.orderNumber} was CANCELLED${ctx.cancelReason ? ` — ${ctx.cancelReason}` : ''}. Refund the customer if they were charged.`;

    // The restaurant did these themselves. Don't text people their own actions.
    case 'ACCEPTED':
    case 'PREPARING':
    case 'READY':
    case 'OUT_FOR_DELIVERY':
      return null;

    default:
      return null;
  }
}

/** PICKUP / DELIVERY / DINE_IN → the French words the kitchen reads. */
function fulfillmentFr(fulfillment: OrderContext['fulfillment']): string {
  return fulfillment === 'DELIVERY' ? 'livraison' : fulfillment === 'DINE_IN' ? 'sur place' : 'à emporter';
}

function restaurantSmsFr(status: OrderStatus, ctx: OrderContext): string | null {
  switch (status) {
    case 'PENDING':
      return `NOUVELLE COMMANDE #${ctx.orderNumber} — ${fulfillmentFr(ctx.fulfillment)}${
        ctx.tableNumber ? ` (table ${ctx.tableNumber})` : ''
      }. ${ctx.itemSummary}. ${formatMoney(ctx.totalCents, ctx.currency)}. Acceptez-la dans votre tableau de bord.`;

    case 'DRIVER_ASSIGNED':
      return `Commande #${ctx.orderNumber} : ${ctx.courierName ?? 'un livreur'} vient la récupérer. Préparez-la, emballée et prête.`;

    case 'DELIVERED':
      return `Commande #${ctx.orderNumber} LIVRÉE à ${ctx.customerName}. ${formatMoney(
        ctx.totalCents,
        ctx.currency,
      )} — terminée. Rien de plus à faire.`;

    case 'COMPLETED':
      return ctx.fulfillment === 'DELIVERY'
        ? null
        : `Commande #${ctx.orderNumber} récupérée par ${ctx.customerName}. ${formatMoney(
            ctx.totalCents,
            ctx.currency,
          )} — terminée.`;

    case 'CANCELLED':
      return `Commande #${ctx.orderNumber} ANNULÉE${ctx.cancelReason ? ` — ${ctx.cancelReason}` : ''}. Remboursez le client s'il a été facturé.`;

    default:
      return null;
  }
}

/** Compact enough for an SMS: "2x Classic, 1x Fries (+2 more)". */
export function summariseItems(
  items: Array<{ name: string; quantity: number }>,
  maxItems = 3,
): string {
  const shown = items
    .slice(0, maxItems)
    .map((i) => `${i.quantity}x ${i.name}`)
    .join(', ');
  const remaining = items.length - maxItems;
  return remaining > 0 ? `${shown} (+${remaining} more)` : shown;
}

/** Which statuses warrant an email, and which template. */
export function customerEmailTemplate(status: OrderStatus): string | null {
  switch (status) {
    case 'PENDING':
      return 'receipt'; // paid — here's what you bought
    case 'ACCEPTED':
      return 'confirmed'; // the kitchen said yes
    case 'DELIVERED':
    case 'COMPLETED':
      return 'thank_you'; // the loop closes
    case 'CANCELLED':
      return 'cancelled';
    default:
      return null;
  }
}
