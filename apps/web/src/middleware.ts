import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? 'orderos.ai';

/** Hostnames that are the platform itself, never a restaurant. */
const RESERVED = new Set(['www', 'app', 'api', 'admin', 'dashboard', 'auth']);

/**
 * Is Clerk configured on this deployment?
 *
 * `clerkMiddleware()` THROWS on every request without a publishable key — which
 * would mean a missing auth key takes down the storefront, the thing that takes
 * money, for customers who don't have accounts and never needed auth in the first
 * place. So the storefront's routing runs with no Clerk involvement at all, and
 * Clerk only wraps it when there is actually a key to use.
 */
const CLERK_ENABLED = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_'));

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/onboarding(.*)', '/admin(.*)']);

/**
 * Two apps, one deployment.
 *
 * `orderos.ai`        -> the platform: marketing, sign-in, restaurant dashboard.
 * `joes.orderos.ai`   -> Joe's storefront.
 *
 * The subdomain is extracted here and rewritten into `/s/<slug>`, so storefront
 * pages read the tenant from the path instead of every page re-parsing the Host
 * header. The customer never sees the rewritten URL.
 */
function getTenantSlug(host: string): string | null {
  const hostname = host.split(':')[0].toLowerCase();

  // Local dev: joes.localhost:3000 (works in Chrome; NOT on Windows — see below).
  if (hostname.endsWith('.localhost')) {
    const slug = hostname.slice(0, -'.localhost'.length);
    return RESERVED.has(slug) ? null : slug;
  }

  if (hostname.endsWith(`.${APP_DOMAIN}`)) {
    const slug = hostname.slice(0, -(APP_DOMAIN.length + 1));
    // Only a single label is a tenant — reject nested subdomains.
    if (slug.includes('.') || RESERVED.has(slug)) return null;
    return slug;
  }

  return null; // apex domain, or a preview URL
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * A restaurant's CUSTOM DOMAIN (joesburgers.com) -> their slug.
 *
 * The middleware runs at the edge with no database, so it asks the API. That lookup
 * is on the hot path of every request to a custom domain, so it is cached three
 * ways: Redis on the API side, `next: { revalidate }` here, and negatives cached
 * too — otherwise a stranger pointing a domain at us by mistake would cost a
 * database query on every one of their requests.
 *
 * Returns null on any failure. A domain we cannot resolve falls through to the
 * platform site rather than erroring — a 500 on someone's restaurant homepage
 * because our resolver hiccuped is not an acceptable failure mode.
 */
async function resolveCustomDomain(hostname: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${API_URL}/api/resolve?host=${encodeURIComponent(hostname)}`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return null;

    const body = (await res.json()) as { slug: string | null };
    return body.slug;
  } catch {
    return null;
  }
}

/**
 * Tenant routing. Runs for EVERY request, with or without Clerk.
 *
 * Returns a response when it has handled the request, or null to mean "carry on"
 * — which lets the Clerk wrapper (when there is one) do its auth work afterwards.
 */
async function routeTenant(req: NextRequest): Promise<NextResponse | null> {
  const host = req.headers.get('host') ?? '';
  const { pathname } = req.nextUrl;

  let slug = getTenantSlug(host);

  /**
   * Not one of our own hostnames. It may be a restaurant's own domain.
   *
   * Checked ONLY after the subdomain path fails, so the common case (a tenant on
   * <slug>.orderos.ai) never pays for a network call.
   */
  if (!slug) {
    const hostname = host.split(':')[0].toLowerCase();
    const isOurs =
      hostname === APP_DOMAIN ||
      hostname.endsWith(`.${APP_DOMAIN}`) ||
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.vercel.app');

    if (!isOurs) {
      slug = await resolveCustomDomain(hostname);
    }
  }

  if (slug) {
    // A storefront host must never expose the dashboard: joes.orderos.ai/dashboard
    // would otherwise render the platform UI under a tenant's brand.
    if (pathname.startsWith('/dashboard') || pathname.startsWith('/onboarding')) {
      const url = req.nextUrl.clone();
      url.host = APP_DOMAIN;
      url.pathname = pathname;
      return NextResponse.redirect(url);
    }

    const url = req.nextUrl.clone();
    url.pathname = `/s/${slug}${pathname}`;

    const res = NextResponse.rewrite(url);
    // Downstream server components read the tenant from here rather than
    // re-deriving it from the Host.
    res.headers.set('x-restaurant-slug', slug);
    return res;
  }

  /**
   * On the platform host, `/s/*` is the internal rewrite target and not a public
   * route — serving it off the apex would render a tenant's storefront un-branded
   * and outside their own subdomain.
   *
   * EXCEPT on localhost, where it is the only thing that works: Windows does not
   * resolve `*.localhost` at all (Chrome does it internally; the OS resolver does
   * not), so a developer following the README hits a dead hostname and concludes
   * the app is broken. That is exactly what happened. `/s/<slug>` works everywhere.
   *
   * Gated on the HOST, not NODE_ENV — `next start` runs with NODE_ENV=production,
   * so a NODE_ENV check would leave the demo broken. A request on `localhost` is
   * never a real deployment.
   */
  const hostname = host.split(':')[0].toLowerCase();
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';

  if (pathname.startsWith('/s/') && !isLocal) {
    return NextResponse.rewrite(new URL('/404', req.url));
  }

  return null; // not a storefront request — let auth (if any) take it from here
}

/**
 * Without Clerk: storefront routing only. Staff routes are unreachable anyway
 * (they'd fail at the API), and customers can order.
 */
async function guestOnlyMiddleware(req: NextRequest) {
  return (await routeTenant(req)) ?? NextResponse.next();
}

/** With Clerk: the same routing, plus session protection on staff routes. */
const authenticatedMiddleware = clerkMiddleware(async (auth, req: NextRequest) => {
  const routed = await routeTenant(req);
  if (routed) return routed;

  if (isProtectedRoute(req)) {
    await auth.protect();
  }

  return NextResponse.next();
});

export default CLERK_ENABLED ? authenticatedMiddleware : guestOnlyMiddleware;

export const config = {
  matcher: [
    /**
     * Everything except Next internals, static assets, and the two widget paths.
     *
     * `widget.js` is excluded because it is a public static file fetched
     * cross-origin by every restaurant's website: it needs no session, and on a
     * tenant subdomain the rewrite above would otherwise turn it into
     * /s/<slug>/widget.js and 404 — breaking the widget for any restaurant that
     * loaded it from their own subdomain.
     *
     * `embed` is the widget's iframe: anonymous by definition.
     */
    '/((?!_next/static|_next/image|favicon.ico|widget\\.js|embed|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    '/(api|trpc)(.*)',
  ],
};
