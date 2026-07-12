import { getCountry, isValidTaxId, needsTaxIdForReceipts } from '@orderos/shared';

/**
 * The tax number that makes a receipt a legal document.
 *
 * A wrong number here is not a form-validation nicety. In Canada, India, the UK and
 * Australia a receipt without a valid supplier tax number is not a valid tax invoice:
 * the customer cannot claim it, and the restaurant discovers this at audit, a year of
 * receipts too late.
 *
 * So these tests care about two things, and nothing else:
 *   1. A real number is ACCEPTED. Rejecting a restaurant's genuine GSTIN because our
 *      regex was too clever locks them out of onboarding.
 *   2. Obvious rubbish is REJECTED, so a typo never reaches a receipt.
 */
describe('tax registration numbers', () => {
  describe('India — GSTIN', () => {
    it('accepts a real GSTIN', () => {
      // 29 = Karnataka, then a PAN, entity digit, 'Z', checksum.
      expect(isValidTaxId('IN', '29AAAAA0000A1Z5')).toBe(true);
      expect(isValidTaxId('IN', '07AABCU9603R1ZM')).toBe(true);
    });

    it('rejects one of the wrong length, which is the typo people actually make', () => {
      expect(isValidTaxId('IN', '29AAAAA0000A1Z')).toBe(false);
      expect(isValidTaxId('IN', '29AAAAA0000A1Z55')).toBe(false);
    });

    it('rejects a number missing the mandatory Z in position 14', () => {
      expect(isValidTaxId('IN', '29AAAAA0000A1X5')).toBe(false);
    });
  });

  describe('Canada — GST/HST number', () => {
    it('accepts a business number with or without the RT program suffix', () => {
      expect(isValidTaxId('CA', '123456789RT0001')).toBe(true);
      expect(isValidTaxId('CA', '123456789')).toBe(true);
    });

    it('rejects a business number that is not nine digits', () => {
      expect(isValidTaxId('CA', '12345678')).toBe(false);
      expect(isValidTaxId('CA', 'RT0001')).toBe(false);
    });
  });

  describe('Australia — ABN', () => {
    it('accepts 11 digits, spaced the way the ATO prints them or not', () => {
      expect(isValidTaxId('AU', '51824753556')).toBe(true);
      expect(isValidTaxId('AU', '51 824 753 556')).toBe(true);
    });

    it('rejects 9 digits — that is an ACN, not an ABN', () => {
      expect(isValidTaxId('AU', '824753556')).toBe(false);
    });
  });

  describe('blank', () => {
    it('is always valid — a business below the threshold has no number', () => {
      // Forcing a restaurant to invent a tax number is worse than having none, so
      // blank must pass validation everywhere.
      for (const country of ['US', 'CA', 'IN', 'GB', 'AU', 'IE', 'NZ', 'SG']) {
        expect(isValidTaxId(country, '')).toBe(true);
        expect(isValidTaxId(country, null)).toBe(true);
        expect(isValidTaxId(country, undefined)).toBe(true);
      }
    });
  });

  describe('which countries cannot issue a receipt without one', () => {
    it('flags a Canadian or Indian restaurant that has not given us a number', () => {
      // This is the warning the restaurant needs to see IN ONBOARDING, not at audit.
      expect(needsTaxIdForReceipts('IN', null)).toBe(true);
      expect(needsTaxIdForReceipts('CA', '')).toBe(true);
      expect(needsTaxIdForReceipts('IN', '29AAAAA0000A1Z5')).toBe(false);
    });

    it('does not nag a US restaurant — a US receipt is valid without an EIN', () => {
      expect(needsTaxIdForReceipts('US', null)).toBe(false);
    });
  });

  describe('the label is the one the country actually uses', () => {
    it('never says a generic "Tax ID" — restaurants search for the real name', () => {
      expect(getCountry('IN').taxId.label).toBe('GSTIN');
      expect(getCountry('CA').taxId.label).toBe('GST/HST number');
      expect(getCountry('AU').taxId.label).toBe('ABN');
      expect(getCountry('GB').taxId.label).toBe('VAT number');
    });
  });
});
