/**
 * The countries this product actually works in.
 *
 * A country is not just a dropdown value. Picking one determines the currency, the
 * timezones on offer, the states/provinces list, the tax regime, and — the part
 * everyone forgets — whether Stripe will even let a restaurant there be paid.
 *
 * Country used to be hardcoded to 'US' in the signup wizard, with no picker at all,
 * while the tax step separately asked for a country. So a restaurant in Toronto
 * could set Canadian tax and still be created as a US business, and then fail Stripe
 * onboarding for reasons nobody on either side could see. One source of truth fixes
 * that: pick the country, and everything downstream follows from it.
 */

import { resolveTaxProfile, totalTaxBps, type TaxComponent, type TaxCountry } from './tax';

/**
 * The tax number a restaurant must put on a receipt, as the country defines it.
 *
 * This is not one field with one shape. A GSTIN is 15 characters with a checksum
 * position; an ABN is 11 digits; a Canadian GST/HST number is a 9-digit business
 * number with an RT program suffix. Calling all of them "Tax ID" and validating
 * none of them is how a restaurant issues a year of invalid invoices and finds out
 * at audit.
 *
 * `requiredOnReceipt` is the important flag. Where it is true, a receipt WITHOUT
 * this number is not a legal tax invoice in that country — so we collect it during
 * onboarding rather than discovering it later.
 */
export interface TaxIdSpec {
  /** What the law calls it. Never invent a friendlier name — they search for this. */
  label: string;
  placeholder: string;
  /**
   * Shape check only. It confirms the number LOOKS like what it claims to be; it
   * cannot confirm the number is real or belongs to this business. We never claim
   * otherwise in the UI.
   */
  pattern: RegExp;
  /** True = the receipt is not a valid tax invoice without it. */
  requiredOnReceipt: boolean;
  help: string;
}

export interface Country {
  code: string;
  name: string;
  currency: string;
  /** What a customer's money is called, for labels. */
  currencySymbol: string;
  /** Timezones a restaurant here could plausibly be in. */
  timezones: string[];
  /** What the second line of an address is called HERE. Wrong labels feel foreign. */
  regionLabel: 'State' | 'Province' | 'County' | 'Region';
  postalLabel: 'ZIP code' | 'Postal code' | 'PIN code' | 'Postcode' | 'Eircode';
  /** States / provinces. Empty means free-text. */
  regions: string[];
  /**
   * Can Stripe pay out to a business here via Connect Express?
   *
   * This is the difference between a restaurant that can take money and one that
   * cannot, so it is stated per country rather than discovered at the end of a
   * ten-minute onboarding form.
   */
  stripeSupported: boolean;
  /** Tax regime, if we model it. Otherwise the restaurant enters a flat rate. */
  taxRegime?: TaxCountry;
  /** The tax number that goes on the receipt here. */
  taxId: TaxIdSpec;
}

const US_STATE_LIST = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME',
  'MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA',
  'RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

const CA_PROVINCE_LIST = ['AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT'];

const IN_STATE_LIST = [
  'Andhra Pradesh','Assam','Bihar','Chhattisgarh','Delhi','Goa','Gujarat','Haryana',
  'Himachal Pradesh','Jharkhand','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Odisha',
  'Punjab','Rajasthan','Tamil Nadu','Telangana','Uttar Pradesh','Uttarakhand','West Bengal',
];

const AU_STATE_LIST = ['ACT','NSW','NT','QLD','SA','TAS','VIC','WA'];

/**
 * Why these, and not a list of 195.
 *
 * Each one needs Stripe Connect payouts, a tax story we can defend, and enough
 * independent restaurants losing 30% to a marketplace to make the pitch land. These
 * are the ones where all three are true. Adding a country is cheap; adding one we
 * cannot actually get a restaurant PAID in is a demo that ends in an apology.
 */
export const COUNTRIES: Country[] = [
  {
    code: 'US',
    name: 'United States',
    currency: 'USD',
    currencySymbol: '$',
    timezones: [
      'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
      'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
    ],
    regionLabel: 'State',
    postalLabel: 'ZIP code',
    regions: US_STATE_LIST,
    stripeSupported: true,
    taxRegime: 'US',
    taxId: {
      label: 'EIN',
      placeholder: '12-3456789',
      pattern: /^\d{2}-?\d{7}$/,
      // A US customer receipt does not have to carry the EIN, and most don't. We
      // collect it because the restaurant's accountant wants it — but we never
      // block onboarding on it, and we never print it to customers.
      requiredOnReceipt: false,
      help: 'Your federal employer ID. Kept for your records — not printed on customer receipts.',
    },
  },
  {
    code: 'CA',
    name: 'Canada',
    currency: 'CAD',
    currencySymbol: '$',
    timezones: [
      'America/St_Johns', 'America/Halifax', 'America/Toronto', 'America/Winnipeg',
      'America/Edmonton', 'America/Vancouver',
    ],
    regionLabel: 'Province',
    postalLabel: 'Postal code',
    regions: CA_PROVINCE_LIST,
    stripeSupported: true,
    taxRegime: 'CA',
    taxId: {
      label: 'GST/HST number',
      placeholder: '123456789RT0001',
      /** A 9-digit Business Number, optionally with its RT program suffix. */
      pattern: /^\d{9}(\s?RT\s?\d{4})?$/i,
      // The CRA requires the GST/HST number on receipts over $30. Without it the
      // customer cannot claim an input tax credit, and the receipt is not valid.
      requiredOnReceipt: true,
      help: 'Required by the CRA on receipts over $30. On your GST/HST registration.',
    },
  },
  {
    code: 'IN',
    name: 'India',
    currency: 'INR',
    currencySymbol: '₹',
    timezones: ['Asia/Kolkata'],
    regionLabel: 'State',
    postalLabel: 'PIN code',
    regions: IN_STATE_LIST,
    /**
     * Stripe India does NOT support Connect Express payouts to Indian businesses.
     * A restaurant in Bengaluru can be set up, take orders, and print QR codes — but
     * cannot be paid through Stripe today. Saying so on the signup form is far kinder
     * than letting them discover it after entering their bank details.
     */
    stripeSupported: false,
    taxRegime: 'IN',
    taxId: {
      label: 'GSTIN',
      placeholder: '29AAAAA0000A1Z5',
      /** 2-digit state code, 10-char PAN, entity digit, a literal 'Z', checksum. */
      pattern: /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i,
      // A tax invoice in India is not valid without the supplier's GSTIN on it.
      requiredOnReceipt: true,
      help: 'Required on every tax invoice. 15 characters, beginning with your state code.',
    },
  },
  {
    code: 'GB',
    name: 'United Kingdom',
    currency: 'GBP',
    currencySymbol: '£',
    timezones: ['Europe/London'],
    regionLabel: 'County',
    postalLabel: 'Postcode',
    regions: [],
    stripeSupported: true,
    taxRegime: 'GB',
    taxId: {
      label: 'VAT number',
      placeholder: 'GB123456789',
      pattern: /^(GB)?\d{9}(\d{3})?$/i,
      requiredOnReceipt: true,
      help: 'Required on a VAT invoice. Leave blank if you are not VAT registered.',
    },
  },
  {
    code: 'AU',
    name: 'Australia',
    currency: 'AUD',
    currencySymbol: '$',
    timezones: [
      'Australia/Perth', 'Australia/Adelaide', 'Australia/Brisbane',
      'Australia/Sydney', 'Australia/Melbourne', 'Australia/Hobart',
    ],
    regionLabel: 'State',
    postalLabel: 'Postcode',
    regions: AU_STATE_LIST,
    stripeSupported: true,
    taxRegime: 'AU',
    taxId: {
      label: 'ABN',
      placeholder: '51 824 753 556',
      pattern: /^(\d\s?){11}$/,
      // An Australian tax invoice must show the supplier's ABN.
      requiredOnReceipt: true,
      help: 'Required on a tax invoice. 11 digits.',
    },
  },
  {
    code: 'IE',
    name: 'Ireland',
    currency: 'EUR',
    currencySymbol: '€',
    timezones: ['Europe/Dublin'],
    regionLabel: 'County',
    postalLabel: 'Eircode',
    regions: [],
    stripeSupported: true,
    taxRegime: 'IE',
    taxId: {
      label: 'VAT number',
      placeholder: 'IE1234567FA',
      pattern: /^(IE)?\d{7}[A-W][A-IW]?$/i,
      requiredOnReceipt: true,
      help: 'Required on a VAT invoice. Leave blank if you are not VAT registered.',
    },
  },
  {
    code: 'NZ',
    name: 'New Zealand',
    currency: 'NZD',
    currencySymbol: '$',
    timezones: ['Pacific/Auckland'],
    regionLabel: 'Region',
    postalLabel: 'Postcode',
    regions: [],
    stripeSupported: true,
    taxRegime: 'NZ',
    taxId: {
      label: 'GST number',
      placeholder: '123-456-789',
      pattern: /^\d{2,3}-?\d{3}-?\d{3}$/,
      requiredOnReceipt: true,
      help: 'Required on a tax invoice over $50. 8 or 9 digits.',
    },
  },
  {
    code: 'SG',
    name: 'Singapore',
    currency: 'SGD',
    currencySymbol: '$',
    timezones: ['Asia/Singapore'],
    regionLabel: 'Region',
    postalLabel: 'Postcode',
    regions: [],
    stripeSupported: true,
    taxRegime: 'SG',
    taxId: {
      label: 'GST registration number',
      placeholder: '200312345A',
      pattern: /^[0-9A-Z]{8,10}$/i,
      requiredOnReceipt: true,
      help: 'Required on a tax invoice if you are GST registered.',
    },
  },
  {
    code: 'AE',
    name: 'United Arab Emirates',
    currency: 'AED',
    currencySymbol: 'د.إ',
    timezones: ['Asia/Dubai'],
    /** Dubai, Abu Dhabi, Sharjah… They are emirates, and calling one a "State" reads as foreign. */
    regionLabel: 'Region',
    postalLabel: 'Postcode',
    /**
     * Empty on purpose. The UAE has no functioning postal-code system and addresses
     * are landmark-based — so the seven emirates go in as free text rather than a
     * dropdown that implies a precision the addresses themselves do not have.
     */
    regions: [],
    stripeSupported: true,
    taxRegime: 'AE',
    taxId: {
      label: 'TRN',
      placeholder: '100123456700003',
      /** Tax Registration Number: 15 digits, issued by the Federal Tax Authority. */
      pattern: /^\d{15}$/,
      // A UAE tax invoice must carry the supplier's TRN.
      requiredOnReceipt: true,
      help: 'Your Tax Registration Number from the FTA. Required on a tax invoice. 15 digits.',
    },
  },
];

/**
 * Does this look like a real tax number for this country?
 *
 * Shape only. It cannot tell you the number is registered, or that it belongs to
 * this restaurant — only that it is not a typo or a phone number. Say exactly that
 * in the UI; a green tick that implies "verified with the tax authority" is a lie
 * the restaurant will rely on.
 *
 * Blank is valid. A restaurant below the registration threshold genuinely has no
 * number, and forcing them to invent one is worse than having none.
 */
export function isValidTaxId(countryCode: string, value: string | null | undefined): boolean {
  if (!value?.trim()) return true;
  const spec = getCountry(countryCode).taxId;
  return spec.pattern.test(value.trim().replace(/\s+/g, ' '));
}

/**
 * Is this restaurant able to issue a legal tax invoice?
 *
 * Where the country requires a tax number on the receipt and the restaurant has
 * not given us one, every receipt it sends is invalid. That is worth telling them
 * about — loudly, in onboarding — and it is why this is a function and not a
 * boolean buried in a form.
 */
export function needsTaxIdForReceipts(countryCode: string, taxId: string | null | undefined): boolean {
  return getCountry(countryCode).taxId.requiredOnReceipt && !taxId?.trim();
}

export function getCountry(code: string): Country {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
}

/** All timezones we offer, across every supported country. */
export const ALL_TIMEZONES = [...new Set(COUNTRIES.flatMap((c) => c.timezones))].sort();

/**
 * Everything a restaurant's ADDRESS decides for it.
 *
 * Currency, timezone and tax are not independent settings a restaurant should have to
 * think about — they are consequences of where the restaurant physically is. A place
 * in Toronto is paid in CAD, opens and closes on Toronto time, and charges 13% HST.
 * There is no combination of those three that a Toronto restaurant should be picking
 * by hand, and every one they pick by hand is one they can get wrong.
 *
 * Until this existed, `currency` and `timezone` were schema defaults — USD and
 * America/New_York — that nothing ever updated. A restaurant in Bengaluru was
 * therefore priced in dollars and closed at 10pm Eastern, silently, forever.
 *
 * This is the ONE place that mapping lives. The server calls it when the address
 * changes; the settings form calls it to preview what will change. If they each had
 * their own copy, they would drift, and the drift would show up as a restaurant whose
 * displayed tax and charged tax disagree.
 *
 * The tax components are a PRE-FILL, never a silent commitment — see the honesty note
 * in tax.ts. The caller is expected to show them for confirmation.
 */
export function deriveLocaleDefaults(
  countryCode: string,
  region: string,
): {
  currency: string;
  timezone: string;
  taxCountry: TaxCountry | null;
  taxRegion: string;
  taxComponents: TaxComponent[];
  taxRateBps: number;
} {
  const country = getCountry(countryCode);

  const profile = country.taxRegime
    ? resolveTaxProfile(country.taxRegime, region)
    : null;
  const components = profile?.components ?? [];

  return {
    currency: country.currency,
    /**
     * The first timezone is the country's most populous, not an arbitrary pick — it is
     * the right guess for a country with one zone (all of India is Asia/Kolkata) and a
     * defensible one for a country with several, where the owner can correct it. What
     * it is NOT is America/New_York for a restaurant in Perth.
     */
    timezone: country.timezones[0],
    taxCountry: country.taxRegime ?? null,
    taxRegion: region,
    taxComponents: components,
    taxRateBps: totalTaxBps(components),
  };
}
