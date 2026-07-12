import { retryDelayMs } from './delivery.service';

/**
 * The backoff schedule for re-dispatching a courier.
 *
 * This is not a background job retrying a webhook. It is a bag of hot food sitting
 * on a pass while a customer who has already paid waits for it. The schedule is
 * therefore short and hard-capped, and these tests exist so nobody "improves" it
 * into an hour-long exponential curve without noticing what they've done.
 */
describe('retryDelayMs', () => {
  it('starts at 30 seconds', () => {
    expect(retryDelayMs(1)).toBe(30_000);
  });

  it('doubles each attempt: 30s, 60s, 2m, 4m', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
    expect(retryDelayMs(4)).toBe(240_000);
  });

  it('caps at 8 minutes, however long the outage lasts', () => {
    // An hour-long backoff is indistinguishable from having dropped the order —
    // except the food is now cold as well as late.
    expect(retryDelayMs(5)).toBe(480_000);
    expect(retryDelayMs(9)).toBe(480_000);
    expect(retryDelayMs(50)).toBe(480_000);
  });

  it('never returns a negative or absurd delay for a zeroed counter', () => {
    // attemptCount should never be 0 here, but a delay of 30s * 2^-1 = 15s would be
    // a silently-wrong schedule rather than an error, so it is clamped.
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(-3)).toBe(30_000);
  });

  it('is monotonic — a later attempt never waits less than an earlier one', () => {
    for (let n = 1; n < 20; n++) {
      expect(retryDelayMs(n + 1)).toBeGreaterThanOrEqual(retryDelayMs(n));
    }
  });
});
