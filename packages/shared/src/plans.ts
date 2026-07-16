/**
 * Subscription plans — the SaaS layer on top of the marketplace.
 *
 * DineDirect makes money two ways at once (a deliberate "hybrid" model):
 *
 *   1. A monthly/annual SUBSCRIPTION for the software itself, priced per country.
 *   2. A small per-order COMMISSION on top, which DROPS as the plan goes up — so
 *      moving to a higher tier is cheaper on every order, not only richer in
 *      features. The free tier is funded almost entirely by its commission.
 *
 * This is the ONE source of truth for what each tier costs, what it unlocks, and
 * what it caps. The API enforces it, the dashboard renders it, and the marketing
 * page prices from it — so a plan can never say one thing on the pricing page and
 * mean another at the gate.
 */

export type PlanTier = 'STARTER' | 'GROWTH' | 'PRO';

export type BillingInterval = 'MONTHLY' | 'ANNUAL';

/**
 * Where a subscription is in its lifecycle, mirrored from Stripe. A restaurant is
 * only treated as "on" a paid plan while ACTIVE or TRIALING; PAST_DUE keeps the
 * features on for a short grace period, CANCELED drops them back to Starter.
 */
export type SubscriptionStatus = 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED';

/**
 * Every gate in the product. A capability is a thing a plan either grants or
 * doesn't — checked identically on the server (to refuse the API call) and in the
 * browser (to lock the button and show an upgrade prompt).
 *
 * QR ordering (table / counter / kitchen codes, dine-in and pickup) is deliberately
 * NOT here: it is the baseline every plan has, including the free one. The lowest
 * tier is a "QR system"; a website is the first thing you pay for.
 */
export type PlanCapability =
  /** A public, branded online-ordering storefront at yourname.dinedirect.* */
  | 'WEBSITE_STOREFRONT'
  /** Automatic courier dispatch (Uber / DoorDash Drive) and self-delivery tracking. */
  | 'DELIVERY'
  /** Discount codes and promotions. */
  | 'PROMOTIONS'
  /** Points-based loyalty program. */
  | 'LOYALTY'
  /** Embeddable ordering widget for the restaurant's own existing website. */
  | 'WIDGET'
  /** Full analytics and searchable order history (vs. today-only basics). */
  | 'FULL_ANALYTICS'
  /** Attach a custom domain to the storefront. */
  | 'CUSTOM_DOMAIN'
  /** Per-product stock tracking. */
  | 'INVENTORY'
  /** Staff scheduling, shifts and the activity log. */
  | 'SHIFTS'
  /** Multi-jurisdiction tax reports. */
  | 'TAX_REPORTS'
  /** Drop the "Powered by DineDirect" mark from the storefront. */
  | 'REMOVE_BRANDING';

export interface PlanLimits {
  /** Max menu items (available or not). null = unlimited. */
  maxMenuItems: number | null;
  /** Max active staff members, owner included. null = unlimited. */
  maxStaff: number | null;
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  /** One line for the pricing card. */
  tagline: string;
  /** The capabilities this tier grants. A higher tier is a superset of a lower one. */
  capabilities: PlanCapability[];
  limits: PlanLimits;
  /**
   * The per-order commission this tier pays, in basis points (250 = 2.5%). Set on
   * the restaurant when they land on this tier, and read by order pricing. Drops as
   * the tier rises — the upgrade pays for itself on volume.
   */
  commissionBps: number;
  /** Bullet points for the pricing card, in display order. */
  highlights: string[];
}

/**
 * The three tiers. Each higher tier's capabilities include every lower tier's, so
 * `planAllows` can treat them as a straight superset check without special-casing.
 */
export const PLANS: Record<PlanTier, PlanDefinition> = {
  STARTER: {
    tier: 'STARTER',
    name: 'Starter',
    tagline: 'A full QR ordering system, free.',
    capabilities: [],
    limits: { maxMenuItems: 40, maxStaff: 2 },
    // The free tier is real and has no monthly fee, so the order commission is its
    // ONLY revenue — pitched a little under Owner.com's 5% Flex rate and a small
    // fraction of a marketplace's 15–30% cut.
    commissionBps: 500,
    highlights: [
      'QR ordering for every table & counter',
      'Dine-in and pickup',
      'Kitchen board',
      'Card, Apple & Google Pay checkout',
      'Up to 40 menu items',
      '2 staff seats',
      "Today's sales at a glance",
    ],
  },
  GROWTH: {
    tier: 'GROWTH',
    name: 'Growth',
    tagline: 'Your own ordering website, delivery and marketing.',
    capabilities: [
      'WEBSITE_STOREFRONT',
      'DELIVERY',
      'PROMOTIONS',
      'LOYALTY',
      'WIDGET',
      'FULL_ANALYTICS',
    ],
    limits: { maxMenuItems: null, maxStaff: 10 },
    commissionBps: 200,
    highlights: [
      'Everything in Starter, plus:',
      'Branded ordering website',
      'Automatic delivery dispatch',
      'Promotions & loyalty program',
      'Embeddable ordering widget',
      'Full analytics & order history',
      'Unlimited menu items · 10 staff seats',
      'Commission drops to 2%',
    ],
  },
  PRO: {
    tier: 'PRO',
    name: 'Pro',
    tagline: 'Your own domain, inventory, staffing and lower fees.',
    capabilities: [
      'WEBSITE_STOREFRONT',
      'DELIVERY',
      'PROMOTIONS',
      'LOYALTY',
      'WIDGET',
      'FULL_ANALYTICS',
      'CUSTOM_DOMAIN',
      'INVENTORY',
      'SHIFTS',
      'TAX_REPORTS',
      'REMOVE_BRANDING',
    ],
    limits: { maxMenuItems: null, maxStaff: null },
    // The premium tier is a TRUE flat plan: 0% commission, like ChowNow / Owner.com
    // Flat / Popmenu at $449–499 — but priced under them. A restaurant keeps 100% of
    // every order, so the sticker is the whole cost with no volume penalty.
    commissionBps: 0,
    highlights: [
      'Everything in Growth, plus:',
      'Custom domain',
      'Inventory management',
      'Staff scheduling & activity log',
      'Multi-jurisdiction tax reports',
      'Remove DineDirect branding',
      'Unlimited staff seats',
      '0% commission — keep every dollar',
    ],
  },
};

export const PLAN_TIERS: PlanTier[] = ['STARTER', 'GROWTH', 'PRO'];

/** Rank for comparisons — is tier A at least tier B? */
const TIER_RANK: Record<PlanTier, number> = { STARTER: 0, GROWTH: 1, PRO: 2 };

export function getPlan(tier: PlanTier): PlanDefinition {
  return PLANS[tier] ?? PLANS.STARTER;
}

/** Does a restaurant on this tier get this capability? */
export function planAllows(tier: PlanTier, capability: PlanCapability): boolean {
  return getPlan(tier).capabilities.includes(capability);
}

/** The commission a restaurant on this tier pays per order, in bps. */
export function commissionBpsForTier(tier: PlanTier): number {
  return getPlan(tier).commissionBps;
}

export function planLimit(tier: PlanTier, key: keyof PlanLimits): number | null {
  return getPlan(tier).limits[key];
}

/** True when `tier` is the same as or higher than `atLeast`. */
export function tierAtLeast(tier: PlanTier, atLeast: PlanTier): boolean {
  return TIER_RANK[tier] >= TIER_RANK[atLeast];
}

/** The lowest tier that grants a capability — i.e. the one to upsell to. */
export function lowestTierWith(capability: PlanCapability): PlanTier {
  return PLAN_TIERS.find((t) => planAllows(t, capability)) ?? 'PRO';
}

// ---------------------------------------------------------------------------
// Country-wise pricing
// ---------------------------------------------------------------------------

/**
 * Prices per currency, in minor units (cents / paise / fils), for the MONTHLY plan.
 *
 * These are localised round numbers, NOT a live FX conversion of one USD price — a
 * restaurant in Mumbai should see ₹1,499, not "$39 ≈ ₹3,247". Each is pitched a
 * little under the going rate for restaurant ordering software in that market, with
 * a genuinely free Starter tier. The annual price is ten months for twelve (two
 * months free), computed rather than stored so the two can never disagree.
 *
 * Currencies match the countries we actually support (see countries.ts). Anything
 * we don't have a table for falls back to USD, so a new country can never render a
 * blank or free-by-accident price.
 */
const MONTHLY_PRICE_MINOR: Record<string, Record<PlanTier, number>> = {
  // Benchmarked against real 2026 pricing for direct-ordering software:
  //   Square Online $149 · Popmenu $179–499 · ChowNow $229–449 · Owner.com
  //   $249 (5% comm.) / $499 (0% comm.).
  // The 0%-commission premium players cluster at $449–499. Growth ($199) sits well
  // under them; Pro ($399) matches their offer — a true 0%-commission flat plan —
  // for $50 less, so it's strictly cheaper at any order volume. And we're the only
  // one of the set with a genuinely free tier (funded by its 5% order commission).
  USD: { STARTER: 0, GROWTH: 19900, PRO: 39900 },
  CAD: { STARTER: 0, GROWTH: 26900, PRO: 52900 },
  GBP: { STARTER: 0, GROWTH: 15900, PRO: 31900 },
  EUR: { STARTER: 0, GROWTH: 17900, PRO: 35900 },
  AUD: { STARTER: 0, GROWTH: 28900, PRO: 57900 },
  NZD: { STARTER: 0, GROWTH: 29900, PRO: 59900 },
  SGD: { STARTER: 0, GROWTH: 24900, PRO: 49900 },
  AED: { STARTER: 0, GROWTH: 74900, PRO: 149900 },
  // India is a genuinely lower-priced market for restaurant software (Petpooja,
  // UrbanPiper), so it is localised DOWN, not FX-converted up. Stripe still bills
  // INR in paise, so keep minor units.
  INR: { STARTER: 0, GROWTH: 499900, PRO: 999900 },
};

export const PLAN_PRICING_CURRENCY_FALLBACK = 'USD';

/**
 * Country (ISO-3166 alpha-2) -> the currency we price that country's plans in.
 *
 * Covers the countries we support directly plus the wider Eurozone, so a visitor
 * from Berlin or Paris sees euros rather than dollars. Anything unmapped falls back
 * to USD, so the pricing table can never render blank or free by accident.
 */
const COUNTRY_CURRENCY: Record<string, string> = {
  US: 'USD',
  CA: 'CAD',
  GB: 'GBP',
  AU: 'AUD',
  NZ: 'NZD',
  IN: 'INR',
  SG: 'SGD',
  AE: 'AED',
  IE: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  PT: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  FI: 'EUR',
  GR: 'EUR',
  LU: 'EUR',
};

/**
 * Resolve a country code to the currency we should show it — used to pick the
 * pricing currency from the visitor's geo-IP (server) or their locale (browser),
 * and from a restaurant's own country in the dashboard.
 */
export function currencyForCountry(countryCode?: string | null): string {
  if (!countryCode) return PLAN_PRICING_CURRENCY_FALLBACK;
  const currency = COUNTRY_CURRENCY[countryCode.toUpperCase()];
  return currency && MONTHLY_PRICE_MINOR[currency]
    ? currency
    : PLAN_PRICING_CURRENCY_FALLBACK;
}

export interface PlanPrice {
  tier: PlanTier;
  currency: string;
  /** Per-month cost, minor units. 0 for the free tier. */
  monthlyMinor: number;
  /** Per-year cost, minor units (= 10 × monthly). 0 for the free tier. */
  annualMinor: number;
  /** What the annual plan works out to per month, minor units — the number to headline. */
  annualPerMonthMinor: number;
}

/** Two months free: pay for ten, get twelve. */
const ANNUAL_MONTHS_CHARGED = 10;

function currencyForKey(currencyOrCountry: string): string {
  const key = currencyOrCountry.toUpperCase();
  if (MONTHLY_PRICE_MINOR[key]) return key;
  return PLAN_PRICING_CURRENCY_FALLBACK;
}

/** The price of one tier in one currency. */
export function planPrice(tier: PlanTier, currency: string): PlanPrice {
  const cur = currencyForKey(currency);
  const monthlyMinor = MONTHLY_PRICE_MINOR[cur][tier];
  const annualMinor = monthlyMinor * ANNUAL_MONTHS_CHARGED;
  return {
    tier,
    currency: cur,
    monthlyMinor,
    annualMinor,
    annualPerMonthMinor: Math.round(annualMinor / 12),
  };
}

/** The full pricing table for a currency — every tier, ready to render. */
export function planPricingTable(currency: string): PlanPrice[] {
  return PLAN_TIERS.map((tier) => planPrice(tier, currency));
}

/** Currencies we have a hand-set price table for. */
export function supportedPlanCurrencies(): string[] {
  return Object.keys(MONTHLY_PRICE_MINOR);
}

/** The amount actually billed for a (tier, interval) in a currency, minor units. */
export function billedAmountMinor(
  tier: PlanTier,
  interval: BillingInterval,
  currency: string,
): number {
  const price = planPrice(tier, currency);
  return interval === 'ANNUAL' ? price.annualMinor : price.monthlyMinor;
}
