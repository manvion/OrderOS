import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'OrderOS — Take orders on your own website',
  description:
    'Direct ordering for restaurants. Your website, your customers, your margins — without the marketplace commission.',
};

/**
 * Clerk is only wrapped in when it is actually configured.
 *
 * This is not a demo hack, it is the correct dependency direction: a CUSTOMER
 * ordering a burger has no account and needs no auth provider. Making the entire
 * storefront — the thing that takes money — refuse to render because an auth SDK
 * has no key would mean a Clerk outage or a misconfigured key takes down every
 * restaurant's ordering page along with it.
 *
 * Staff routes (/dashboard, /onboarding) genuinely require Clerk and are protected
 * by middleware, which fails closed. The storefront degrades gracefully: guests
 * order exactly as before, and the optional "Sign in" control simply isn't shown.
 */
const clerkKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
const isClerkConfigured = Boolean(clerkKey && clerkKey.startsWith('pk_'));

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const body = (
    <html lang="en">
      <body>
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );

  if (!isClerkConfigured) return body;

  return <ClerkProvider>{body}</ClerkProvider>;
}
