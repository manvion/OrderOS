/**
 * Which payment rail a restaurant collects on, decided by the country it operates in.
 *
 * Stripe Connect covers the countries in countries.ts where `stripeSupported` is true
 * (US, CA, GB, AU, IE, NZ, SG, AE). India is the exception: Stripe India does not
 * support Connect Express payouts, so an Indian restaurant collects through
 * Razorpay Route instead — the Indian aggregator that accepts UPI (PhonePe / Google
 * Pay / Paytm), cards, netbanking and wallets and splits each payment to the
 * restaurant while we keep our commission.
 *
 * This is the ONE place the mapping lives, so the API (which provider service to
 * call), the checkout (Stripe redirect vs Razorpay modal) and onboarding all agree.
 */

export type PaymentProvider = 'STRIPE' | 'RAZORPAY';

/** Country code (ISO-3166 alpha-2) -> the payment provider that country collects on. */
export function paymentProviderForCountry(countryCode: string | null | undefined): PaymentProvider {
  return countryCode?.toUpperCase() === 'IN' ? 'RAZORPAY' : 'STRIPE';
}

/** True when the country collects via Razorpay rather than Stripe. */
export function usesRazorpay(countryCode: string | null | undefined): boolean {
  return paymentProviderForCountry(countryCode) === 'RAZORPAY';
}
