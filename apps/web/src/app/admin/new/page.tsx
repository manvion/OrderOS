import { SignupWizard } from '@/components/onboarding/signup-wizard';

export const dynamic = 'force-dynamic';

/**
 * Onboarding a restaurant on their behalf, on a phone call.
 *
 * Deliberately the SAME wizard the restaurant would fill in themselves, in admin
 * mode — which adds who owns it and what we charge, and nothing else. The admin
 * panel used to have its own shorter form that never asked about tax, hours or
 * fulfillment, so a restaurant we onboarded by hand went live on default hours
 * charging 0% tax while a self-signup did not. Two forms means the second one is
 * always the one that's wrong.
 */
export default function AdminNewRestaurantPage() {
  return <SignupWizard mode="admin" />;
}
