/**
 * Best-effort E.164 phone formatting for the courier APIs.
 *
 * Uber Direct and DoorDash Drive REJECT anything that isn't `+<countrycode><number>`
 * with a flat "the parameters of your request were invalid" 400 — which then spins
 * the dispatch retry loop on an error retrying can never fix. But customers and
 * restaurants type phones however they please: "(514) 555-1234", "514-555-1234",
 * "5145551234". This adds the country's calling code (from the restaurant's country)
 * when the number doesn't already carry one, so a real number typed the normal way
 * dispatches instead of erroring.
 *
 * It cannot rescue a genuinely bogus number: a test "888888888" becomes a
 * well-formed-but-fake "+1888888888" that the courier still declines — but now with a
 * PERMANENT decline the pipeline stops retrying, instead of spinning "retrying
 * automatically" forever. Only a number too short to dial at all (< 7 digits) returns
 * undefined. This is deliberately dependency-free (no libphonenumber): it covers the
 * markets this product serves and defers the final yes/no to the courier.
 */
const CALLING_CODES: Record<string, string> = {
  CA: '1',
  US: '1',
  MX: '52',
  IN: '91',
  GB: '44',
  IE: '353',
  FR: '33',
  DE: '49',
  ES: '34',
  IT: '39',
  NL: '31',
  AU: '61',
  NZ: '64',
  AE: '971',
  SG: '65',
};

export function toE164(
  raw: string | null | undefined,
  countryIso2: string | null | undefined,
): string | undefined {
  if (!raw) return undefined;

  const cleaned = raw.replace(/[^\d+]/g, '');

  // Already international — trust it, just tidy it.
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  }

  const digits = cleaned;
  // Too short to be a real, dialable number — nothing to send a courier.
  if (digits.length < 7) return undefined;

  const cc = CALLING_CODES[(countryIso2 ?? '').toUpperCase()] ?? '1';

  // North American numbers are sometimes typed with the leading 1 already (a
  // valid NANP national number is 10 digits and never starts with 1, so an
  // 11-digit "1XXXXXXXXXX" already carries the country code).
  if (cc === '1' && digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }

  return `+${cc}${digits}`;
}
