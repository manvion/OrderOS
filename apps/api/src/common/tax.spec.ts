import {
  computeTax,
  priceOrder,
  resolveTaxProfile,
  totalTaxBps,
  IN_GST_STANDARD,
  IN_GST_HOTEL,
} from '@dinedirect/shared';

/**
 * Tax across the three countries we support.
 *
 * These are not style tests. A wrong tax rate means the restaurant either
 * under-collects (and pays the shortfall out of their own margin at audit) or
 * over-charges their customers. Both are our fault, and both are the kind of thing
 * that ends a B2B relationship.
 */

const burger = {
  productId: 'p1',
  name: 'Burger',
  unitPriceCents: 1000,
  quantity: 1,
  modifiers: [],
};

describe('Canada', () => {
  it('charges Ontario a single HST line at 13%', () => {
    const profile = resolveTaxProfile('CA', 'ON');
    expect(profile.components).toEqual([{ name: 'HST', rateBps: 1300 }]);

    const result = priceOrder({
      items: [burger],
      taxRateBps: 0,
      taxComponents: profile.components,
      fulfillment: 'PICKUP',
    });

    expect(result.taxLines).toEqual([{ name: 'HST', rateBps: 1300, amountCents: 130 }]);
    expect(result.totalCents).toBe(1130);
  });

  it('charges Quebec GST and QST as SEPARATE named lines', () => {
    // The whole reason tax is a list rather than a number. A receipt that says
    // "Tax 14.975%" instead of naming GST and QST separately is not legal here.
    const profile = resolveTaxProfile('CA', 'QC');
    expect(profile.components).toEqual([
      { name: 'GST', rateBps: 500 },
      { name: 'QST', rateBps: 998 },
    ]);

    const result = priceOrder({
      items: [burger],
      taxRateBps: 0,
      taxComponents: profile.components,
      fulfillment: 'PICKUP',
    });

    expect(result.taxLines.map((l) => l.name)).toEqual(['GST', 'QST']);
    expect(result.taxLines[0].amountCents).toBe(50); // 5% of 1000
    expect(result.taxLines[1].amountCents).toBe(100); // 9.975% of 1000 = 99.75 -> 100
    expect(result.taxCents).toBe(150);
  });

  it('does NOT compound QST on top of GST', () => {
    // Quebec stopped compounding in 2013. Compounding would give 5% then 9.975%
    // OF (base + GST) = 104.74, not 99.75. Getting this wrong overcharges every
    // Quebec customer by a small amount forever, which is exactly how you end up
    // in a class action.
    const { totalCents } = computeTax(10_000, [
      { name: 'GST', rateBps: 500 },
      { name: 'QST', rateBps: 998 },
    ]);
    expect(totalCents).toBe(500 + 998); // both on the same base
  });

  it('charges Alberta GST only', () => {
    expect(resolveTaxProfile('CA', 'AB').components).toEqual([{ name: 'GST', rateBps: 500 }]);
  });

  it('charges BC as GST + PST', () => {
    expect(resolveTaxProfile('CA', 'BC').components).toEqual([
      { name: 'GST', rateBps: 500 },
      { name: 'PST', rateBps: 700 },
    ]);
  });
});

describe('India', () => {
  it('splits restaurant GST into CGST and SGST at 2.5% each', () => {
    // 5% total, but a tax invoice MUST itemise the central and state halves.
    const profile = resolveTaxProfile('IN', 'Karnataka');
    expect(profile.components).toEqual(IN_GST_STANDARD);
    expect(totalTaxBps(profile.components)).toBe(500); // 5%

    const result = priceOrder({
      items: [burger],
      taxRateBps: 0,
      taxComponents: profile.components,
      fulfillment: 'DINE_IN',
    });

    expect(result.taxLines.map((l) => l.name)).toEqual(['CGST', 'SGST']);
    expect(result.taxCents).toBe(50); // 25 + 25
  });

  it('charges 18% for a restaurant inside an expensive hotel', () => {
    // Only they know this, which is why the wizard asks rather than assumes.
    const profile = resolveTaxProfile('IN', 'Maharashtra', { indiaHotelRate: true });
    expect(profile.components).toEqual(IN_GST_HOTEL);
    expect(totalTaxBps(profile.components)).toBe(1800);
  });
});

describe('United States', () => {
  it('pre-fills the state base rate as a single line', () => {
    expect(resolveTaxProfile('US', 'CA').components).toEqual([
      { name: 'Sales Tax', rateBps: 725 },
    ]);
    expect(resolveTaxProfile('US', 'NY').components).toEqual([
      { name: 'Sales Tax', rateBps: 400 },
    ]);
  });

  it('returns NO components for states with no sales tax', () => {
    // Oregon, Montana, New Hampshire, Delaware. Returning a 0% line would print
    // "Sales Tax $0.00" on every receipt, which is noise, not information.
    for (const state of ['OR', 'MT', 'NH', 'DE']) {
      expect(resolveTaxProfile('US', state).components).toEqual([]);
    }
  });

  it('returns nothing for an unknown region rather than guessing zero', () => {
    // Guessing 0% would silently under-collect. An empty list forces the question.
    expect(resolveTaxProfile('US', 'ZZ').components).toEqual([]);
  });
});

describe('tax and the rest of the bill', () => {
  it('taxes the service fee but NOT delivery or tip', () => {
    const result = priceOrder({
      items: [burger], // 1000
      taxRateBps: 0,
      taxComponents: [{ name: 'HST', rateBps: 1300 }],
      fulfillment: 'DELIVERY',
      serviceFeeCents: 100,
      deliveryFeeCents: 500,
      tipCents: 200,
    });

    // Taxable base is 1000 + 100 = 1100. 13% -> 143.
    expect(result.taxCents).toBe(143);
    // NOT (1000 + 100 + 500 + 200) * 13%.
    expect(result.totalCents).toBe(1000 + 100 + 500 + 200 + 143);
  });

  it('taxes the DISCOUNTED subtotal', () => {
    const result = priceOrder({
      items: [burger],
      taxRateBps: 0,
      taxComponents: [{ name: 'HST', rateBps: 1300 }],
      fulfillment: 'PICKUP',
      discountCents: 500,
    });
    // 500 taxable, not 1000.
    expect(result.taxCents).toBe(65);
  });

  it('rounds each line individually, so printed lines add up to the printed total', () => {
    // An auditor WILL notice if the receipt's tax lines don't sum to its tax total.
    const { lines, totalCents } = computeTax(3333, [
      { name: 'GST', rateBps: 500 },
      { name: 'QST', rateBps: 998 },
    ]);
    expect(lines.reduce((s, l) => s + l.amountCents, 0)).toBe(totalCents);
  });

  it('falls back to the single rate when no components are given', () => {
    // Legacy orders and the simple US case.
    const result = priceOrder({ items: [burger], taxRateBps: 875, fulfillment: 'PICKUP' });
    expect(result.taxCents).toBe(88);
    expect(result.taxLines).toEqual([{ name: 'Tax', rateBps: 875, amountCents: 88 }]);
  });

  it('emits no tax lines at all when the restaurant charges no tax', () => {
    const result = priceOrder({ items: [burger], taxRateBps: 0, fulfillment: 'PICKUP' });
    expect(result.taxCents).toBe(0);
    expect(result.taxLines).toEqual([]);
  });
});
