import { distanceMeters } from './geocoding.service';

/**
 * The delivery radius maths.
 *
 * `deliveryRadiusMeters` was decorative for the whole life of this project: stored,
 * validated, shown in the settings UI, and enforced NOWHERE. A restaurant could set
 * a 2km radius and still be handed an order from 40km away, eating a courier fee for
 * a delivery they'd never have accepted.
 *
 * This is the maths that makes it real, so it gets tested.
 */
describe('distanceMeters', () => {
  // Two real points ~1.4km apart in San Francisco.
  const restaurant = { latitude: 37.7879, longitude: -122.3972 }; // 535 Mission St
  const nearby = { latitude: 37.7749, longitude: -122.4194 }; // Civic Center-ish

  it('measures a short city distance', () => {
    const d = distanceMeters(restaurant, nearby);
    // ~2.1km. Assert a band, not an exact float — the point is the order of
    // magnitude is right, not that we've reimplemented WGS84.
    expect(d).toBeGreaterThan(1800);
    expect(d).toBeLessThan(2600);
  });

  it('is zero for the same point', () => {
    expect(distanceMeters(restaurant, restaurant)).toBeLessThan(1);
  });

  it('is symmetric', () => {
    expect(Math.round(distanceMeters(restaurant, nearby))).toBe(
      Math.round(distanceMeters(nearby, restaurant)),
    );
  });

  it('measures a long distance sanely', () => {
    // SF -> LA is ~559km great-circle. If someone breaks the haversine into a
    // flat-earth approximation, this is the test that screams.
    const la = { latitude: 34.0522, longitude: -118.2437 };
    const d = distanceMeters(restaurant, la);
    expect(d).toBeGreaterThan(540_000);
    expect(d).toBeLessThan(580_000);
  });

  it('handles crossing the equator and the meridian', () => {
    // Naive latitude/longitude subtraction gets sign errors here.
    const d = distanceMeters({ latitude: 1, longitude: 1 }, { latitude: -1, longitude: -1 });
    expect(d).toBeGreaterThan(300_000);
    expect(d).toBeLessThan(320_000);
  });

  it('decides in/out of a radius the way a restaurant owner means it', () => {
    const RADIUS = 3_000; // "we deliver 3km around us"

    const inRange = { latitude: 37.79, longitude: -122.4 };
    const outOfRange = { latitude: 37.85, longitude: -122.5 };

    expect(distanceMeters(restaurant, inRange)).toBeLessThanOrEqual(RADIUS);
    expect(distanceMeters(restaurant, outOfRange)).toBeGreaterThan(RADIUS);
  });
});
