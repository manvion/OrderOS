import { canTransition, isOpenAt, priceOrder, type BusinessHours } from '@dinedirect/shared';

/**
 * These cover the three places where a bug costs real money or real food:
 * the total we charge, the transitions we allow, and whether we're open.
 */

describe('priceOrder', () => {
  const burger = {
    productId: 'p1',
    name: 'The Classic',
    unitPriceCents: 1200,
    quantity: 1,
    modifiers: [],
  };

  it('sums modifiers into the unit price before multiplying by quantity', () => {
    const result = priceOrder({
      items: [
        {
          ...burger,
          quantity: 2,
          modifiers: [
            { modifierId: 'm1', name: 'Large', priceCents: 400, quantity: 1 },
            { modifierId: 'm2', name: 'Bacon', priceCents: 250, quantity: 1 },
          ],
        },
      ],
      taxRateBps: 0,
      fulfillment: 'PICKUP',
    });

    // (1200 + 400 + 250) * 2 — NOT 1200*2 + 650.
    expect(result.subtotalCents).toBe(3700);
  });

  it('taxes the discounted subtotal plus service fee, but not delivery or tip', () => {
    const result = priceOrder({
      items: [burger],
      taxRateBps: 875, // 8.75%
      fulfillment: 'DELIVERY',
      deliveryFeeCents: 499,
      serviceFeeCents: 100,
      tipCents: 300,
      discountCents: 200,
    });

    // Taxable base: 1200 - 200 + 100 = 1100. 1100 * 8.75% = 96.25 -> 96.
    expect(result.taxCents).toBe(96);
    // 1200 - 200 + 96 + 499 + 100 + 300
    expect(result.totalCents).toBe(1995);
  });

  it('never lets a discount exceed the subtotal', () => {
    const result = priceOrder({
      items: [burger],
      taxRateBps: 0,
      fulfillment: 'PICKUP',
      discountCents: 999_99, // absurdly large coupon
    });

    expect(result.discountCents).toBe(1200);
    expect(result.totalCents).toBe(0); // zero, never negative
  });

  it('ignores the delivery fee on a pickup order', () => {
    const result = priceOrder({
      items: [burger],
      taxRateBps: 0,
      fulfillment: 'PICKUP',
      deliveryFeeCents: 499,
    });

    expect(result.deliveryFeeCents).toBe(0);
    expect(result.totalCents).toBe(1200);
  });

  it('rounds tax to the nearest cent rather than truncating', () => {
    // 1000 * 8.75% = 87.5 -> 88, not 87.
    const result = priceOrder({
      items: [{ ...burger, unitPriceCents: 1000 }],
      taxRateBps: 875,
      fulfillment: 'PICKUP',
    });
    expect(result.taxCents).toBe(88);
  });
});

describe('order state machine', () => {
  it('allows the happy delivery path', () => {
    expect(canTransition('PENDING', 'ACCEPTED')).toBe(true);
    expect(canTransition('ACCEPTED', 'PREPARING')).toBe(true);
    expect(canTransition('PREPARING', 'READY')).toBe(true);
    expect(canTransition('READY', 'DRIVER_ASSIGNED')).toBe(true);
    expect(canTransition('DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY')).toBe(true);
    expect(canTransition('OUT_FOR_DELIVERY', 'DELIVERED')).toBe(true);
  });

  it('allows READY -> COMPLETED for pickup, skipping the courier states', () => {
    expect(canTransition('READY', 'COMPLETED')).toBe(true);
  });

  it('refuses to skip the kitchen', () => {
    expect(canTransition('PENDING', 'READY')).toBe(false);
    expect(canTransition('PENDING', 'DELIVERED')).toBe(false);
  });

  it('refuses to move backwards', () => {
    expect(canTransition('READY', 'PREPARING')).toBe(false);
    expect(canTransition('DELIVERED', 'PREPARING')).toBe(false);
  });

  it('treats CANCELLED and COMPLETED as terminal', () => {
    expect(canTransition('CANCELLED', 'ACCEPTED')).toBe(false);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
  });

  it('allows cancellation right up until the food is with the customer', () => {
    expect(canTransition('PENDING', 'CANCELLED')).toBe(true);
    expect(canTransition('PREPARING', 'CANCELLED')).toBe(true);
    expect(canTransition('OUT_FOR_DELIVERY', 'CANCELLED')).toBe(true);
    // But not once it has landed.
    expect(canTransition('DELIVERED', 'CANCELLED')).toBe(false);
  });
});

describe('isOpenAt', () => {
  const hours = (windows: Array<{ open: string; close: string }>): BusinessHours =>
    ({
      sunday: { closed: true, windows: [] },
      monday: { closed: false, windows },
      tuesday: { closed: false, windows },
      wednesday: { closed: false, windows },
      thursday: { closed: false, windows },
      friday: { closed: false, windows },
      saturday: { closed: false, windows },
    }) as BusinessHours;

  it('is open inside the window and closed outside it', () => {
    const h = hours([{ open: '11:00', close: '22:00' }]);
    // Monday 2024-03-11, 18:00 UTC = 13:00 New York.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-11T18:00:00Z'))).toBe(true);
    // Monday 09:00 New York — before opening.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-11T13:00:00Z'))).toBe(false);
  });

  it('respects the restaurant timezone, not the server timezone', () => {
    const h = hours([{ open: '11:00', close: '22:00' }]);
    // The same instant, read in two zones. 2024-03-11T17:00Z (both zones are on
    // daylight time) is 13:00 in New York — open — but only 10:00 in Los Angeles,
    // an hour before they unlock the door.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-11T17:00:00Z'))).toBe(true);
    expect(isOpenAt(h, 'America/Los_Angeles', new Date('2024-03-11T17:00:00Z'))).toBe(false);
  });

  it('handles a window that crosses midnight', () => {
    const h = hours([{ open: '17:00', close: '02:00' }]);
    // Tuesday 01:00 New York — still inside Monday's window.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-12T05:00:00Z'))).toBe(true);
    // Tuesday 03:00 New York — after it closed.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-12T07:00:00Z'))).toBe(false);
  });

  it('handles split shifts', () => {
    const h = hours([
      { open: '11:00', close: '14:00' },
      { open: '17:00', close: '22:00' },
    ]);
    // 12:00 NY — lunch service.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-11T16:00:00Z'))).toBe(true);
    // 15:00 NY — the afternoon gap.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-11T19:00:00Z'))).toBe(false);
    // 18:00 NY — dinner service.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-11T22:00:00Z'))).toBe(true);
  });

  it('is closed on a closed day', () => {
    const h = hours([{ open: '11:00', close: '22:00' }]);
    // Sunday 2024-03-10, 17:00 UTC = 13:00 NY.
    expect(isOpenAt(h, 'America/New_York', new Date('2024-03-10T17:00:00Z'))).toBe(false);
  });
});
