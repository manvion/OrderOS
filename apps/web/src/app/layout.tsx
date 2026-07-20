import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Fraunces, Schibsted_Grotesk } from 'next/font/google';
import { Toaster } from 'sonner';
import './globals.css';

/**
 * Typography is the whole ballgame. Until now NO font was loaded anywhere — every
 * page rendered in the visitor's system stack, which is the fastest way for a
 * product to read as "template". These two are self-hosted by next/font (no
 * external request, no layout shift, works under the strictest CSP):
 *
 *   Fraunces — a warm, food-editorial serif for display type. Restaurant names,
 *   menu section heads, hero lines. It reads "printed menu", not "admin panel",
 *   which is the exact register a restaurant's own website should hit.
 *
 *   Schibsted Grotesk — the working sans for everything else. Distinctive enough
 *   not to be Yet Another Inter Deployment, neutral enough to disappear behind
 *   forty tenants' brand colours.
 */
const displayFont = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  // The optical-size axis is what makes Fraunces sing at hero sizes.
  axes: ['opsz'],
});

const sansFont = Schibsted_Grotesk({
  subsets: ['latin'],
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: 'DineDirect — Take orders on your own website',
  description:
    'Direct ordering for restaurants. Your website, your customers, your margins — without the marketplace commission.',
  manifest: '/manifest.webmanifest',
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
    <html lang="en" className={`${displayFont.variable} ${sansFont.variable}`}>
      <body className="font-sans">
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );

  if (!isClerkConfigured) return body;

  // The root provider covers staff/admin auth (/sign-in, /onboarding), where the
  // specific restaurant isn't known yet — so it carries the platform name, never
  // Clerk's raw application name ("restro"). The storefront nests its own provider
  // (see s/[slug]/layout.tsx) to show each restaurant's own name to customers.
  return (
    <ClerkProvider
      localization={{
        signIn: { start: { title: 'Sign in to DineDirect' } },
        signUp: { start: { title: 'Create your DineDirect account' } },
      }}
    >
      {body}
    </ClerkProvider>
  );
}
