import { computeTax, type TaxComponent, type TaxLine } from './tax';

/**
 * Authoritative order pricing.
 *
 * All money is integer cents. This module is imported by BOTH the browser cart
 * (for the live preview) and the API (for the real total that is charged), so
 * the number the customer sees is computed by the same code that bills them.
 * The API never trusts client-sent prices — it re-reads them from the database
 * and re-runs this function.
 */

export interface PricedModifier {
  modifierId: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export interface PricedLineItem {
  productId: string;
  name: string;
  /** Base unit price of the product, before modifiers. */
  unitPriceCents: number;
  quantity: number;
  modifiers: PricedModifier[];
}

export interface PricingInput {
  items: PricedLineItem[];
  /**
   * Basis points, e.g. 875 = 8.75%.
   *
   * Used only when `taxComponents` is absent. A single rate cannot express Quebec
   * (GST 5% + QST 9.975%) or India (CGST 2.5% + SGST 2.5%), both of which must
   * appear as separate named lines on a legal receipt — so multi-component tax is
   * the real path and this is the simple fallback.
   */
  taxRateBps: number;
  /**
   * Named tax components. When present, these are authoritative and `taxRateBps`
   * is ignored. See packages/shared/src/tax.ts.
   */
  taxComponents?: TaxComponent[];
  fulfillment: 'PICKUP' | 'DELIVERY' | 'DINE_IN';
  /** What the restaurant charges the customer for delivery. */
  deliveryFeeCents?: number;
  /**
   * Whether the delivery fee is part of the taxable base.
   *
   * Delivery-charge taxability is jurisdiction-specific: in Canada a restaurant's own
   * delivery charge on taxable food is generally taxable, whereas many US states don't
   * tax it. So it's a per-restaurant setting rather than a hardcoded rule. Default
   * false (delivery untaxed) — the historical behaviour.
   */
  taxDeliveryFee?: boolean;
  /** Flat service fee the restaurant adds to every order. */
  serviceFeeCents?: number;
  tipCents?: number;
  discountCents?: number;
}

export interface LineItemTotal {
  productId: string;
  /** unitPrice + sum(modifier prices), i.e. the price of one configured unit. */
  effectiveUnitPriceCents: number;
  quantity: number;
  /** effectiveUnitPrice * quantity. */
  totalCents: number;
}

export interface PricingResult {
  lineItems: LineItemTotal[];
  subtotalCents: number;
  discountCents: number;
  /** The total tax charged. Always equals the sum of `taxLines`. */
  taxCents: number;
  /**
   * Tax, broken out exactly as it must be printed: "GST £2.50", "QST £4.99".
   * Empty when the restaurant charges no tax.
   */
  taxLines: TaxLine[];
  deliveryFeeCents: number;
  serviceFeeCents: number;
  tipCents: number;
  totalCents: number;
}

export function computeLineItemTotal(item: PricedLineItem): LineItemTotal {
  const modifiersCents = item.modifiers.reduce(
    (sum, m) => sum + m.priceCents * Math.max(1, m.quantity),
    0,
  );
  const effectiveUnitPriceCents = item.unitPriceCents + modifiersCents;
  return {
    productId: item.productId,
    effectiveUnitPriceCents,
    quantity: item.quantity,
    totalCents: effectiveUnitPriceCents * item.quantity,
  };
}

export function priceOrder(input: PricingInput): PricingResult {
  const lineItems = input.items.map(computeLineItemTotal);
  const subtotalCents = lineItems.reduce((sum, li) => sum + li.totalCents, 0);

  // Discount can never exceed the subtotal — a coupon must not create a credit.
  const discountCents = Math.min(Math.max(0, input.discountCents ?? 0), subtotalCents);

  const deliveryFeeCents = input.fulfillment === 'DELIVERY' ? (input.deliveryFeeCents ?? 0) : 0;
  const serviceFeeCents = input.serviceFeeCents ?? 0;
  const tipCents = Math.max(0, input.tipCents ?? 0);

  // Tax applies to the discounted food subtotal plus the service fee, and — when the
  // restaurant is in a jurisdiction that taxes it (input.taxDeliveryFee) — the
  // delivery fee too. Tips are never taxed.
  const taxableCents =
    subtotalCents - discountCents + serviceFeeCents + (input.taxDeliveryFee ? deliveryFeeCents : 0);

  /**
   * Components win when present. They are the only way to charge Quebec (GST +
   * QST) or India (CGST + SGST) correctly, and the only way to PRINT them
   * correctly — a receipt that says "Tax 14.975%" instead of naming GST and QST
   * separately is not a valid receipt in Quebec.
   *
   * `taxRateBps` remains for the simple single-rate case (most of the US).
   */
  const { lines: taxLines, totalCents: taxCents } =
    input.taxComponents && input.taxComponents.length > 0
      ? computeTax(taxableCents, input.taxComponents)
      : input.taxRateBps > 0
        ? computeTax(taxableCents, [{ name: 'Tax', rateBps: input.taxRateBps }])
        : { lines: [] as TaxLine[], totalCents: 0 };

  const totalCents =
    subtotalCents - discountCents + taxCents + deliveryFeeCents + serviceFeeCents + tipCents;

  return {
    lineItems,
    subtotalCents,
    discountCents,
    taxCents,
    taxLines,
    deliveryFeeCents,
    serviceFeeCents,
    tipCents,
    totalCents,
  };
}

export function formatMoney(cents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** 8.75% -> 875 bps. Used when a restaurant owner types a percentage into settings. */
export function percentToBps(percent: number): number {
  return Math.round(percent * 100);
}

export function bpsToPercent(bps: number): number {
  return bps / 100;
}
