import { SignupWizard } from '@/components/onboarding/signup-wizard';

/**
 * Signup is authenticated (Clerk) and inherently dynamic — there is no static
 * version of it, and prerendering would force Clerk to run at build time.
 */
export const dynamic = 'force-dynamic';

export default function OnboardingPage() {
  return <SignupWizard />;
}
