import { buildSetupChecklist, publishBlockers, setupProgress, type SetupFacts } from '@dinedirect/shared';

/** A restaurant that has done everything. Each test breaks exactly one thing. */
const READY: SetupFacts = {
  orderingMode: 'WEBSITE',
  categoryCount: 3,
  availableProductCount: 12,
  activeQrCount: 0,
  stripeChargesEnabled: true,
  pickupEnabled: true,
  deliveryEnabled: false,
  dineInEnabled: false,
  hasLogo: true,
  taxRateBps: 875,
  isPublished: false,
};

const blockerIds = (f: SetupFacts) => publishBlockers(buildSetupChecklist(f)).map((s) => s.id);

describe('setup checklist', () => {
  it('lets a fully set-up restaurant publish', () => {
    expect(blockerIds(READY)).toEqual([]);
  });

  describe('what blocks going live', () => {
    it('blocks with no menu items', () => {
      expect(blockerIds({ ...READY, availableProductCount: 0 })).toContain('menu');
    });

    it('blocks with products but no category', () => {
      // The exact case the admin console used to miss: it counted products only, so
      // an owner blocked by a missing category saw a blocker their support agent did not.
      expect(blockerIds({ ...READY, categoryCount: 0 })).toContain('menu');
    });

    it('blocks when every product is unavailable', () => {
      // A menu of sold-out items is not a menu.
      expect(blockerIds({ ...READY, availableProductCount: 0, categoryCount: 3 })).toContain('menu');
    });

    it('blocks without Stripe — there is nowhere for the money to go', () => {
      expect(blockerIds({ ...READY, stripeChargesEnabled: false })).toContain('stripe');
    });

    it('blocks with no fulfillment method at all', () => {
      expect(
        blockerIds({
          ...READY,
          pickupEnabled: false,
          deliveryEnabled: false,
          dineInEnabled: false,
        }),
      ).toContain('fulfillment');
    });

    it('accepts any single fulfillment method', () => {
      for (const only of ['pickupEnabled', 'deliveryEnabled', 'dineInEnabled'] as const) {
        const facts: SetupFacts = {
          ...READY,
          pickupEnabled: false,
          deliveryEnabled: false,
          dineInEnabled: false,
          [only]: true,
        };
        expect(blockerIds(facts)).toEqual([]);
      }
    });
  });

  describe('QR-only restaurants', () => {
    const QR: SetupFacts = { ...READY, orderingMode: 'QR_ONLY', dineInEnabled: true };

    it('CANNOT publish without a QR code — it is the only way in', () => {
      expect(blockerIds({ ...QR, activeQrCount: 0 })).toContain('qr');
    });

    it('can publish once a code exists', () => {
      expect(blockerIds({ ...QR, activeQrCount: 4 })).toEqual([]);
    });

    it('says WHY, not just that it is missing', () => {
      const qr = buildSetupChecklist({ ...QR, activeQrCount: 0 }).find((s) => s.id === 'qr')!;
      expect(qr.why).toMatch(/no website/i);
    });
  });

  describe('a website restaurant', () => {
    it('does NOT need QR codes to go live', () => {
      expect(blockerIds({ ...READY, activeQrCount: 0 })).toEqual([]);
    });
  });

  describe('advice, which must never block a business from opening', () => {
    it('does not block on a missing logo', () => {
      expect(blockerIds({ ...READY, hasLogo: false })).toEqual([]);
      const logo = buildSetupChecklist({ ...READY, hasLogo: false }).find((s) => s.id === 'logo')!;
      expect(logo.required).toBe(false);
      expect(logo.done).toBe(false);
    });

    it('does not block on 0% tax, but does keep asking', () => {
      // Zero tax is a legitimate ANSWER. It is not a legitimate default, so it
      // stays on the list — visible, unticked, and not in anyone's way.
      expect(blockerIds({ ...READY, taxRateBps: 0 })).toEqual([]);
      const tax = buildSetupChecklist({ ...READY, taxRateBps: 0 }).find((s) => s.id === 'tax')!;
      expect(tax.done).toBe(false);
      expect(tax.required).toBe(false);
    });
  });

  describe('progress', () => {
    it('counts required steps only, so advice cannot inflate it', () => {
      expect(setupProgress(buildSetupChecklist(READY))).toEqual({ done: 3, total: 3 });
    });

    it('reports partial progress for a half-finished restaurant', () => {
      const half = { ...READY, stripeChargesEnabled: false, availableProductCount: 0 };
      expect(setupProgress(buildSetupChecklist(half))).toEqual({ done: 1, total: 3 });
    });

    it('counts the QR step for a QR-only restaurant', () => {
      const qr: SetupFacts = { ...READY, orderingMode: 'QR_ONLY', activeQrCount: 0 };
      expect(setupProgress(buildSetupChecklist(qr))).toEqual({ done: 3, total: 4 });
    });
  });
});
