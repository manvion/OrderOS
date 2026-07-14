import { customerEmailTemplate, customerSms, restaurantSms, summariseItems, type OrderContext } from './templates';

/**
 * The routing rules for notifications.
 *
 * A bug here is invisible in a build and catastrophic in production: either the
 * customer never hears their food is ready, or we text the kitchen about their
 * own button presses until they mute us and then miss a real order.
 */

const ctx = (overrides: Partial<OrderContext> = {}): OrderContext => ({
  orderNumber: '0712-001',
  customerName: 'Sam Rivera',
  restaurantName: 'Bella Burger',
  restaurantPhone: '+14155550123',
  fulfillment: 'DELIVERY',
  totalCents: 5629,
  currency: 'USD',
  trackingUrl: 'https://bellaburger.dinedirect.manvion.ca/track/trk_abc',
  prepTimeMinutes: 20,
  itemSummary: '2x The Classic, 1x Fries',
  ...overrides,
});

describe('customer SMS', () => {
  it('texts on the moments that matter', () => {
    expect(customerSms('PENDING', ctx())).toContain('0712-001'); // paid
    expect(customerSms('ACCEPTED', ctx())).toContain('confirmed');
    expect(customerSms('DELIVERED', ctx())).toContain('delivered');
  });

  it('stays SILENT on PREPARING', () => {
    // The customer already knows it was accepted and can watch the tracker.
    // Texting here trains them to ignore us, and then the READY text — the one
    // that actually matters — gets lost in the noise.
    expect(customerSms('PREPARING', ctx())).toBeNull();
  });

  it('says "ready for pickup" for pickup, not for delivery', () => {
    const pickup = customerSms('READY', ctx({ fulfillment: 'PICKUP' }));
    expect(pickup).toContain('READY for pickup');

    // "Your order is ready" to a delivery customer is a lie — it's ready for the
    // DRIVER, not for them, and they'd stand at the door for 20 minutes.
    const delivery = customerSms('READY', ctx({ fulfillment: 'DELIVERY' }));
    expect(delivery).not.toContain('READY for pickup');
    expect(delivery).toContain('driver');
  });

  it('puts the handoff code in the pickup READY text — it IS the walk to the counter', () => {
    // This message is the moment the customer stands up and leaves. If the code is
    // not in it, they arrive at a queue and start digging through old texts for the
    // tracking link, which is exactly the fumbling at the counter we set out to fix.
    const message = customerSms('READY', ctx({ fulfillment: 'PICKUP', handoffCode: 'K7M2' }));
    expect(message).toContain('K7M2');
    expect(message).toContain('counter');
  });

  it('still reads correctly for an order placed before handoff codes existed', () => {
    // Nullable column: these orders have no code. The text must not say "give code
    // null at the counter", and must not print a code that is not on the bag.
    const message = customerSms('READY', ctx({ fulfillment: 'PICKUP', handoffCode: null }));
    expect(message).toContain('READY for pickup');
    expect(message).not.toContain('code');
    expect(message).not.toContain('null');
  });

  it('names the courier and links Uber\'s live map when one is assigned', () => {
    const message = customerSms(
      'DRIVER_ASSIGNED',
      ctx({ courierName: 'Marcus', courierTrackingUrl: 'https://uber.com/track/xyz' }),
    );
    expect(message).toContain('Marcus');
    expect(message).toContain('https://uber.com/track/xyz');
  });

  it('falls back to our own tracking page when Uber gave us no map', () => {
    const message = customerSms('DRIVER_ASSIGNED', ctx({ courierTrackingUrl: null }));
    expect(message).toContain('/track/trk_abc');
  });

  it('thanks the customer exactly once', () => {
    // A delivery order gets its thank-you on DELIVERED. It then also transitions
    // to COMPLETED — which must NOT send a second thank-you.
    expect(customerSms('DELIVERED', ctx({ fulfillment: 'DELIVERY' }))).toContain('Thank you');
    expect(customerSms('COMPLETED', ctx({ fulfillment: 'DELIVERY' }))).toBeNull();

    // A pickup order never passes through DELIVERED, so COMPLETED is where its
    // thank-you lives.
    expect(customerSms('COMPLETED', ctx({ fulfillment: 'PICKUP' }))).toContain('thanks');
  });

  it('tells a cancelled customer about their refund', () => {
    const message = customerSms('CANCELLED', ctx({ cancelReason: 'Kitchen closed early' }));
    expect(message).toContain('Kitchen closed early');
    expect(message).toContain('refunded');
  });
});

describe('restaurant SMS', () => {
  it('shouts about a new order, with the items in it', () => {
    const message = restaurantSms('PENDING', ctx());
    expect(message).toContain('NEW ORDER');
    expect(message).toContain('0712-001');
    // The kitchen needs to know WHAT was ordered, not just that something was.
    expect(message).toContain('2x The Classic');
  });

  it('flags the table on a dine-in order', () => {
    const message = restaurantSms('PENDING', ctx({ fulfillment: 'DINE_IN', tableNumber: '4' }));
    expect(message).toContain('table 4');
  });

  it('tells the restaurant the order is COMPLETE once delivered', () => {
    // This is the loop closing on their side: the owner never physically saw the
    // delivery finish, and wants to know there's nothing left to do.
    const message = restaurantSms('DELIVERED', ctx({ courierName: 'Marcus' }));
    expect(message).toContain('DELIVERED');
    expect(message).toContain('complete');
  });

  it('does NOT text the restaurant about their own button presses', () => {
    // They pressed Accept. Texting them "you accepted" is absurd, and a kitchen
    // that gets spammed mutes us — and then misses the NEW ORDER text.
    expect(restaurantSms('ACCEPTED', ctx())).toBeNull();
    expect(restaurantSms('PREPARING', ctx())).toBeNull();
    expect(restaurantSms('READY', ctx())).toBeNull();
  });

  it('does not double-notify on a delivery order reaching COMPLETED', () => {
    expect(restaurantSms('DELIVERED', ctx({ fulfillment: 'DELIVERY' }))).not.toBeNull();
    expect(restaurantSms('COMPLETED', ctx({ fulfillment: 'DELIVERY' }))).toBeNull();
  });
});

describe('customerEmailTemplate', () => {
  it('emails only at the bookends of the order', () => {
    expect(customerEmailTemplate('PENDING')).toBe('receipt');
    expect(customerEmailTemplate('ACCEPTED')).toBe('confirmed');
    expect(customerEmailTemplate('DELIVERED')).toBe('thank_you');
    expect(customerEmailTemplate('CANCELLED')).toBe('cancelled');

    // Nobody wants an email that says "your burger is now being prepared".
    expect(customerEmailTemplate('PREPARING')).toBeNull();
    expect(customerEmailTemplate('READY')).toBeNull();
    expect(customerEmailTemplate('DRIVER_ASSIGNED')).toBeNull();
  });
});

describe('summariseItems', () => {
  it('keeps an SMS short by truncating a long order', () => {
    const items = [
      { name: 'Classic', quantity: 2 },
      { name: 'Fries', quantity: 1 },
      { name: 'Shake', quantity: 3 },
      { name: 'Rings', quantity: 1 },
      { name: 'Soda', quantity: 2 },
    ];
    // A 20-item order must not become a four-part SMS the restaurant pays for.
    expect(summariseItems(items)).toBe('2x Classic, 1x Fries, 3x Shake (+2 more)');
  });

  it('does not add a suffix when everything fits', () => {
    expect(summariseItems([{ name: 'Classic', quantity: 1 }])).toBe('1x Classic');
  });
});
