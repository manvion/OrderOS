import { CourierRouter } from './courier.router';
import {
  CourierDeclinedError,
  CourierUnavailableError,
  type Courier,
  type CourierQuote,
  type CourierQuoteRequest,
} from './courier.interface';

/**
 * The router is where running two couriers actually pays for itself, so these tests
 * are about money and about not stranding paid orders — not about plumbing.
 */

const REQUEST: CourierQuoteRequest = {
  pickup: { street: '1 Main St', city: 'Toronto', state: 'ON', postalCode: 'M5V', country: 'CA' },
  dropoff: { street: '9 Bay St', city: 'Toronto', state: 'ON', postalCode: 'M5J', country: 'CA' },
  pickupReadyAt: new Date('2026-07-12T18:00:00Z'),
  orderValueCents: 4200,
  externalId: 'order_1',
};

/** A restaurant with both couriers switched on. */
const BOTH = { uberDirectEnabled: true, doorDashEnabled: true, porterEnabled: false };

function fakeCourier(
  provider: 'UBER' | 'DOORDASH' | 'PORTER',
  behaviour: { feeCents?: number; declines?: string; broken?: string; configured?: boolean },
): Courier {
  const quote = jest.fn(async (): Promise<CourierQuote> => {
    if (behaviour.declines) throw new CourierDeclinedError(behaviour.declines, provider);
    if (behaviour.broken) throw new CourierUnavailableError(behaviour.broken, provider);

    return {
      provider,
      quoteId: `${provider}_q`,
      feeCents: behaviour.feeCents!,
      currency: 'CAD',
      expiresAt: null,
      dropoffEta: null,
      durationMinutes: null,
    };
  });

  return {
    provider,
    isConfigured: behaviour.configured ?? true,
    quote,
    createDelivery: jest.fn(),
    getDelivery: jest.fn(),
    cancelDelivery: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  } as unknown as Courier;
}

function router(uber: Courier, doordash: Courier): CourierRouter {
  // The router only ever touches the Courier surface of these, so the concrete client
  // classes are irrelevant to what is being tested here. Porter is India-only and off
  // in these Canada scenarios — a disabled mock keeps it out of the quoting.
  const porter = fakeCourier('PORTER', { configured: false });
  return new CourierRouter(uber as never, doordash as never, porter as never);
}

describe('CourierRouter', () => {
  it('takes the cheaper courier when both will go', async () => {
    const uber = fakeCourier('UBER', { feeCents: 899 });
    const doordash = fakeCourier('DOORDASH', { feeCents: 645 });

    const { quote } = await router(uber, doordash).bestQuote(BOTH, REQUEST);

    // $2.54 a delivery, on every delivery. This is the entire feature.
    expect(quote?.provider).toBe('DOORDASH');
    expect(quote?.feeCents).toBe(645);
  });

  it('quotes both couriers in parallel rather than serially', async () => {
    const uber = fakeCourier('UBER', { feeCents: 899 });
    const doordash = fakeCourier('DOORDASH', { feeCents: 645 });

    await router(uber, doordash).quoteAll(BOTH, REQUEST);

    // Checkout is already waiting on a network call. Doubling that latency to save
    // nothing would be a real cost paid by every customer.
    expect(uber.quote).toHaveBeenCalledTimes(1);
    expect(doordash.quote).toHaveBeenCalledTimes(1);
  });

  it('uses the courier that WILL go when the other declines', async () => {
    const uber = fakeCourier('UBER', { declines: 'Outside our delivery zone' });
    const doordash = fakeCourier('DOORDASH', { feeCents: 700 });

    const { quote } = await router(uber, doordash).bestQuote(BOTH, REQUEST);

    expect(quote?.provider).toBe('DOORDASH');
  });

  it('fails over when a courier is BROKEN, not just declining', async () => {
    // The resilience half of the argument: Uber having a bad afternoon must not mean
    // a paid, cooked order cannot be delivered.
    const uber = fakeCourier('UBER', { broken: '503 Service Unavailable' });
    const doordash = fakeCourier('DOORDASH', { feeCents: 700 });

    const { quote } = await router(uber, doordash).bestQuote(BOTH, REQUEST);

    expect(quote?.provider).toBe('DOORDASH');
    expect(quote?.feeCents).toBe(700);
  });

  it('surfaces a real decline reason when every courier declines', async () => {
    const uber = fakeCourier('UBER', { declines: 'Outside our delivery zone' });
    const doordash = fakeCourier('DOORDASH', { declines: 'Address not serviceable' });

    const { quote, declineReason } = await router(uber, doordash).bestQuote(BOTH, REQUEST);

    expect(quote).toBeNull();
    // A specific, actionable sentence from a working courier beats a generic failure.
    expect(declineReason).toBe('Outside our delivery zone');
  });

  it('gives no decline reason when every courier is merely BROKEN', async () => {
    const uber = fakeCourier('UBER', { broken: '500' });
    const doordash = fakeCourier('DOORDASH', { broken: 'timeout' });

    const { quote, declineReason } = await router(uber, doordash).bestQuote(BOTH, REQUEST);

    expect(quote).toBeNull();
    // An outage is not something a customer can act on, so they must not be told
    // "that address is outside our zone" — which would be a lie.
    expect(declineReason).toBeNull();
  });

  it('skips a courier the restaurant has not switched on', async () => {
    const uber = fakeCourier('UBER', { feeCents: 899 });
    const doordash = fakeCourier('DOORDASH', { feeCents: 100 });

    const { quote } = await router(uber, doordash).bestQuote(
      { uberDirectEnabled: true, doorDashEnabled: false, porterEnabled: false },
      REQUEST,
    );

    // DoorDash is cheaper and must still NOT be used: the restaurant has no contract
    // with them. Quoting them anyway would dispatch a courier the restaurant cannot
    // be billed for.
    expect(quote?.provider).toBe('UBER');
    expect(doordash.quote).not.toHaveBeenCalled();
  });

  it('skips a courier that is switched on but has no credentials', async () => {
    const uber = fakeCourier('UBER', { feeCents: 899 });
    const doordash = fakeCourier('DOORDASH', { feeCents: 100, configured: false });

    const { quote } = await router(uber, doordash).bestQuote(BOTH, REQUEST);

    expect(quote?.provider).toBe('UBER');
    expect(doordash.quote).not.toHaveBeenCalled();
  });

  it('returns nothing when no courier is enabled at all', async () => {
    const uber = fakeCourier('UBER', { feeCents: 899 });
    const doordash = fakeCourier('DOORDASH', { feeCents: 645 });

    const { quotes } = await router(uber, doordash).quoteAll(
      { uberDirectEnabled: false, doorDashEnabled: false, porterEnabled: false },
      REQUEST,
    );

    // Self-delivery. The caller must treat this as "no courier", never as "free".
    expect(quotes).toEqual([]);
  });

  it('refuses to hand a SELF delivery to a courier API', () => {
    const r = router(fakeCourier('UBER', { feeCents: 1 }), fakeCourier('DOORDASH', { feeCents: 1 }));

    // A restaurant's own moped rider has no API. Reaching here is a bug in the caller,
    // and it must say so rather than returning a null client that fails three frames
    // later somewhere confusing.
    expect(() => r.forProvider('SELF')).toThrow(/not dispatched through a courier API/);
  });
});
