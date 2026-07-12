import { z } from 'zod';

/**
 * Tax.
 *
 * A single `taxRateBps` cannot express how the world actually taxes restaurant
 * food, and pretending otherwise produces receipts that are illegal in most of the
 * countries we support:
 *
 *  - CANADA: Quebec charges GST 5% + QST 9.975% as SEPARATE, separately-named lines.
 *    Ontario charges a single HST 13%. Both must be shown as they are charged.
 *  - INDIA: restaurant GST is 5%, but it is levied as CGST 2.5% + SGST 2.5% and a
 *    tax invoice must itemise both.
 *  - US: one sales tax line, but the rate depends on the state (and, in truth, on
 *    the county and city too — see the honesty note below).
 *  - GB / IE / AU / NZ / SG / AE: a single national VAT or GST line. Easy — but the
 *    line still has to be NAMED correctly ("VAT", not "Tax"), because the name is
 *    what makes it a claimable input credit for a business customer.
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

/**
 * Countries whose tax we MODEL, as opposed to countries we merely operate in.
 *
 * Being on this list means we can pre-fill a defensible rate from the jurisdiction.
 * A country not on it still works — the restaurant just enters its own rate, which
 * is the honest fallback, and far better than inventing a number for them.
 */
export const SUPPORTED_TAX_COUNTRIES = [
  'US', 'CA', 'IN', 'GB', 'IE', 'AU', 'NZ', 'SG', 'AE',
] as const;
export type TaxCountry = (typeof SUPPORTED_TAX_COUNTRIES)[number];

export const taxProfileSchema = z.object({
  country: z.enum(SUPPORTED_TAX_COUNTRIES),
  /** State, province, or — for the single-rate countries — empty. Free text: jurisdictions change. */
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

/**
 * The single-rate countries: one national VAT/GST line, no regional variation.
 *
 * The NAME is not decoration. A UK receipt that says "Tax" instead of "VAT" is not a
 * valid VAT invoice, and a business customer cannot reclaim against it. So each of
 * these carries the name the law uses, and that name is what gets printed.
 *
 * The rate that applies to RESTAURANT FOOD, which is not always the headline rate:
 *
 *  - GB  20%    Standard-rated. Eat-in and hot takeaway food are both standard-rated;
 *               only cold takeaway food is zero-rated. Restaurants are 20%.
 *  - IE  13.5%  The REDUCED rate. Ireland taxes restaurant and catering services at
 *               13.5%, not the 23% standard rate — using 23% would overcharge every
 *               customer by nearly 10 points.
 *  - AU  10%    GST. Flat, and food sold prepared for consumption is taxable.
 *  - NZ  15%    GST. Flat, and famously applies to almost everything.
 *  - SG   9%    GST. Raised from 8% to 9% on 1 January 2024.
 *  - AE   5%    VAT.
 *
 * These are national rates set by statute and changed rarely, so unlike the US table
 * below they are safe to pre-fill. They are still shown for confirmation, because a
 * restaurant may be below a registration threshold and charging nothing at all.
 */
const SINGLE_RATE_COMPONENTS: Record<string, TaxComponent[]> = {
  GB: [{ name: 'VAT', rateBps: 2000 }],
  IE: [{ name: 'VAT', rateBps: 1350 }],
  AU: [{ name: 'GST', rateBps: 1000 }],
  NZ: [{ name: 'GST', rateBps: 1500 }],
  SG: [{ name: 'GST', rateBps: 900 }],
  AE: [{ name: 'VAT', rateBps: 500 }],
};

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

  // One national rate, no regional variation. `region` is carried through unchanged
  // rather than dropped — a UK restaurant still has a county, it just doesn't affect
  // the tax, and throwing the address away here would be surprising.
  const singleRate = SINGLE_RATE_COMPONENTS[country];
  if (singleRate) {
    return { country, region: key, components: singleRate };
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
