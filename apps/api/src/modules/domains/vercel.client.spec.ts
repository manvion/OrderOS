import {
  isApexDomain,
  requiredDnsRecords,
  VERCEL_APEX_A_RECORD,
  VERCEL_CNAME_TARGET,
} from './vercel.client';

/**
 * These two functions ARE the custom-domain feature.
 *
 * Everything else (attach to Vercel, poll, issue a cert) is plumbing that either
 * works or errors loudly. This is the part that fails SILENTLY: hand a restaurant
 * owner the wrong record type and they paste it into their registrar, wait, and
 * conclude our product is broken. There is no error anywhere for them to see.
 */
describe('DNS records for a custom domain', () => {
  describe('isApexDomain', () => {
    it('treats a plain registrable domain as apex', () => {
      expect(isApexDomain('joesburgers.com')).toBe(true);
      expect(isApexDomain('joesburgers.ca')).toBe(true);
      expect(isApexDomain('joesburgers.in')).toBe(true);
    });

    it('treats a two-part public suffix as apex, despite the extra dot', () => {
      // Counting dots says "3 labels, must be a subdomain" — and that is exactly
      // how you end up instructing a CNAME on an apex, which DNS forbids.
      expect(isApexDomain('joesburgers.co.uk')).toBe(true);
      expect(isApexDomain('joesburgers.co.in')).toBe(true);
      expect(isApexDomain('joesburgers.com.au')).toBe(true);
    });

    it('treats anything below the registrable domain as not apex', () => {
      expect(isApexDomain('order.joesburgers.com')).toBe(false);
      expect(isApexDomain('order.joesburgers.co.uk')).toBe(false);
      expect(isApexDomain('www.joesburgers.com')).toBe(false);
    });
  });

  describe('requiredDnsRecords', () => {
    it('gives an apex an A record — an apex cannot take a CNAME', () => {
      expect(requiredDnsRecords('joesburgers.com')).toEqual([
        { type: 'A', name: '@', value: VERCEL_APEX_A_RECORD },
      ]);
    });

    it('gives a .co.uk apex an A record too', () => {
      expect(requiredDnsRecords('joesburgers.co.uk')).toEqual([
        { type: 'A', name: '@', value: VERCEL_APEX_A_RECORD },
      ]);
    });

    it('gives a subdomain a CNAME named after the label below the apex', () => {
      expect(requiredDnsRecords('order.joesburgers.com')).toEqual([
        { type: 'CNAME', name: 'order', value: VERCEL_CNAME_TARGET },
      ]);
    });

    it('keeps every label above the registrable domain in the CNAME name', () => {
      // Registrars want the name relative to the zone, so `shop.order`, not `shop`.
      expect(requiredDnsRecords('shop.order.joesburgers.com')).toEqual([
        { type: 'CNAME', name: 'shop.order', value: VERCEL_CNAME_TARGET },
      ]);
    });

    it('handles a subdomain under a two-part suffix', () => {
      expect(requiredDnsRecords('order.joesburgers.co.uk')).toEqual([
        { type: 'CNAME', name: 'order', value: VERCEL_CNAME_TARGET },
      ]);
    });

    it('is case-insensitive — registrars and users type domains however they like', () => {
      expect(requiredDnsRecords('Order.JoesBurgers.COM')).toEqual([
        { type: 'CNAME', name: 'order', value: VERCEL_CNAME_TARGET },
      ]);
    });
  });
});
