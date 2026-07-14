/**
 * The one answer to "what is this restaurant's web address?"
 *
 * Every surface that shows or links a storefront URL — the signup wizard's
 * "your web address" preview, the dashboard's "view my site", the admin
 * console — must agree, and none of them may hardcode a domain the operator
 * doesn't own.
 *
 * Two regimes, decided by whether the operator has configured a real apex:
 *
 *   NEXT_PUBLIC_APP_DOMAIN set   -> subdomain tenancy: https://<slug>.<apex>
 *   unset                         -> path tenancy on whatever host we're on:
 *                                    <current origin>/s/<slug>
 *
 * The second regime is what makes a Vercel deployment honest: `fff.dinedirect.manvion.ca`
 * on a machine that doesn't own dinedirect.manvion.ca is a URL that resolves for nobody,
 * shown at the exact moment a new restaurant is being promised their website.
 * The moment the operator sets a real domain and redeploys, every surface
 * flips to subdomains at once — nothing else to change.
 */
export function hasApexDomain(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_APP_DOMAIN);
}

export function tenantUrl(slug: string): string {
  const apex = process.env.NEXT_PUBLIC_APP_DOMAIN;
  if (apex) return `https://${slug}.${apex}`;

  // Client components know exactly where they're running.
  if (typeof window !== 'undefined') return `${window.location.origin}/s/${slug}`;

  // Server render with no apex configured: a relative path is always correct.
  return `/s/${slug}`;
}
