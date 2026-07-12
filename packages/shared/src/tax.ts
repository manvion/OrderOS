import { z } from 'zod';

/**
 * Tax.
 *
 * A single `taxRateBps` cannot express how the world actually taxes restaurant
 * food, and pretending otherwise produces receipts that are illegal in two of the
 * three countries we support:
 *
 *  - CANADA: Quebec charges GST 5% + QST 9.975% as SEPARATE, separately-named lines.
 *    Ontario charges a single HST 13%. Both must be shown as they are charged.
 *  - INDIA: restaurant GST is 5%, but it is levied as CGST 2.5% + SGST 2.5% and a
 *    tax invoice must itemise both.
 *  - US: one sales tax line, but the rate depends on the state (and, in truth, on
 *    the county and city too — see the honesty note below).
 *
 * So tax is a LIST of named components, not a number. The receipt shows what was
 * actually charged, under the names the law uses.
 */

export const taxComponentSchema = z.object({
  /** Exactly as it must appear on the receipt: "HST", "QST", "CGST", "Sales Tax". */
  name: z.string().min(1).max(24),
  /** Basis points. 9.975% = 998 (rounded). 13% = 1300. */
  rateBps: z.number().int().min(0).max(3000),
});

export type TaxComponent = z.infer<typeof taxComponentSchema>;

export const taxProfileSchema = z.object({
  country: z.enum(['US', 'CA', 'IN']),
  /** State (US), province (CA), or state (IN). Free text — jurisdictions change. */
  region: z.string().max(40),
  components: z.array(taxComponentSchema).max(4),
});

export type TaxProfile = z.infer<typeof taxProfileSchema>;

/**
 * Sensible defaults per jurisdiction, so a restaurant doesn't have to research
 * their own tax code to sign up.
 *
 * ------------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING THESE NUMBERS.
 *
 * US rates below are the STATE base rate only. Actual sales tax on prepared food
 * is state + county + city, varies between neighbouring streets, changes several
 * times a year, and in some states prepared food is taxed at a special rate. There
 * are ~11,000 US sales-tax jurisdictions. No hardcoded table is correct, and any
 * product claiming otherwise is lying to its customers.
 *
 * So: we PRE-FILL, we say plainly that we've pre-filled, and we make the restaurant
 * confirm or correct it. The confirmation is the product; the table is a courtesy.
 * Anyone operating at scale should replace this with a real tax API (Avalara,
 * TaxJar, Stripe Tax) — the seam for that is `resolveTaxProfile`.
 *
 * Canadian rates are reliable (province-level, few of them, changed rarely).
 * India's restaurant GST is reliable (5% = CGST 2.5 + SGST 2.5 for most
 * restaurants; 18% applies to restaurants in hotels with room tariffs above
 * ₹7,500, which the owner must select themselves).
 * ------------------------------------------------------------------------------
 */

/** US: state base rates, in basis points. Local tax is ADDITIONAL and not included. */
const US_STATE_BASE_BPS: Record<string, number> = {
  AL: 400, AK: 0, AZ: 560, AR: 650, CA: 725, CO: 290, CT: 635, DE: 0,
  FL: 600, GA: 400, HI: 400, ID: 600, IL: 625, IN: 700, IA: 600, KS: 650,
  KY: 600, LA: 445, ME: 550, MD: 600, MA: 625, MI: 600, MN: 688, MS: 700,
  MO: 423, MT: 0, NE: 550, NV: 685, NH: 0, NJ: 663, NM: 488, NY: 400,
  NC: 475, ND: 500, OH: 575, OK: 450, OR: 0, PA: 600, RI: 700, SC: 600,
  SD: 420, TN: 700, TX: 625, UT: 610, VT: 600, VA: 530, WA: 650, WV: 600,
  WI: 500, WY: 400, DC: 600,
};

/**
 * Canada: GST/HST/PST/QST by province.
 *
 * HST provinces charge one combined tax. Everyone else charges federal GST 5% plus
 * a provincial tax — and Quebec's QST is 9.975%, which is precisely why rates are
 * basis points and not percentages.
 */
const CA_PROVINCE_COMPONENTS: Record<string, TaxComponent[]> = {
  // HST provinces: a single line.
  ON: [{ name: 'HST', rateBps: 1300 }],
  NB: [{ name: 'HST', rateBps: 1500 }],
  NL: [{ name: 'HST', rateBps: 1500 }],
  NS: [{ name: 'HST', rateBps: 1400 }],
  PE: [{ name: 'HST', rateBps: 1500 }],

  // GST + provincial: two lines, both named on the receipt.
  BC: [{ name: 'GST', rateBps: 500 }, { name: 'PST', rateBps: 700 }],
  MB: [{ name: 'GST', rateBps: 500 }, { name: 'PST', rateBps: 700 }],
  SK: [{ name: 'GST', rateBps: 500 }, { name: 'PST', rateBps: 600 }],
  QC: [{ name: 'GST', rateBps: 500 }, { name: 'QST', rateBps: 998 }], // 9.975%

  // GST only.
  AB: [{ name: 'GST', rateBps: 500 }],
  NT: [{ name: 'GST', rateBps: 500 }],
  NU: [{ name: 'GST', rateBps: 500 }],
  YT: [{ name: 'GST', rateBps: 500 }],
};

/**
 * India: restaurant GST, split into central and state halves.
 *
 * 5% (2.5 + 2.5) is the standard rate for restaurants, with no input tax credit.
 * 18% (9 + 9) applies to restaurants inside hotels with declared room tariffs above
 * ₹7,500 — which the owner has to tell us, because we cannot know it.
 */
export const IN_GST_STANDARD: TaxComponent[] = [
  { name: 'CGST', rateBps: 250 },
  { name: 'SGST', rateBps: 250 },
];

export const IN_GST_HOTEL: TaxComponent[] = [
  { name: 'CGST', rateBps: 900 },
  { name: 'SGST', rateBps: 900 },
];

export const SUPPORTED_TAX_COUNTRIES = ['US', 'CA', 'IN'] as const;
export type TaxCountry = (typeof SUPPORTED_TAX_COUNTRIES)[number];

export const CA_PROVINCES = Object.keys(CA_PROVINCE_COMPONENTS);
export const US_STATES = Object.keys(US_STATE_BASE_BPS);

/**
 * Best-effort default for a jurisdiction. ALWAYS shown to the restaurant for
 * confirmation — never applied silently.
 *
 * Returns an empty component list when we genuinely don't know, which is honest and
 * forces the question, rather than guessing zero and quietly under-charging them.
 */
export function resolveTaxProfile(
  country: TaxCountry,
  region: string,
  opts: { indiaHotelRate?: boolean } = {},
): TaxProfile {
  const key = region.trim().toUpperCase();

  if (country === 'CA') {
    return {
      country,
      region: key,
      components: CA_PROVINCE_COMPONENTS[key] ?? [{ name: 'GST', rateBps: 500 }],
    };
  }

  if (country === 'IN') {
    return {
      country,
      region: key,
      components: opts.indiaHotelRate ? IN_GST_HOTEL : IN_GST_STANDARD,
    };
  }

  // US. State base only — local tax is on top, and we say so in the UI.
  const base = US_STATE_BASE_BPS[key];
  return {
    country,
    region: key,
    components: base === undefined
      ? []
      : base === 0
        ? [] // genuinely no sales tax (OR, MT, NH, DE, AK at state level)
        : [{ name: 'Sales Tax', rateBps: base }],
  };
}

export interface TaxLine {
  name: string;
  rateBps: number;
  amountCents: number;
}

/**
 * Compute tax from components.
 *
 * Every component is applied to the same taxable base — NOT compounded on top of
 * each other. This is correct for all three countries we support: Quebec stopped
 * compounding QST on GST in 2013, and India's CGST/SGST are both levied on the
 * base value. If we ever support a jurisdiction that genuinely compounds, that is a
 * new field on TaxComponent, not a silent change here.
 *
 * Each line is rounded to the cent INDIVIDUALLY, because that is what appears on
 * the receipt and what the restaurant must remit. Rounding the total instead would
 * make the printed lines fail to add up to the printed total — which is the kind of
 * thing an auditor notices.
 */
export function computeTax(taxableCents: number, components: TaxComponent[]): {
  lines: TaxLine[];
  totalCents: number;
} {
  const lines = components.map((c) => ({
    name: c.name,
    rateBps: c.rateBps,
    amountCents: Math.round((taxableCents * c.rateBps) / 10_000),
  }));

  return {
    lines,
    totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
  };
}

/** The combined rate, for display ("13% tax") and for legacy single-rate callers. */
export function totalTaxBps(components: TaxComponent[]): number {
  return components.reduce((sum, c) => sum + c.rateBps, 0);
}
