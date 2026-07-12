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
  taxRegime?: 'US' | 'CA' | 'IN';
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
  },
];

export function getCountry(code: string): Country {
  return COUNTRIES.find((c) => c.code === code) ?? COUNTRIES[0];
}

/** All timezones we offer, across every supported country. */
export const ALL_TIMEZONES = [...new Set(COUNTRIES.flatMap((c) => c.timezones))].sort();
