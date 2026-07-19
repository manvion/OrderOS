import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ClerkProvider } from '@clerk/nextjs';
import { ApiRequestError, storefrontApi } from '@/lib/api';
import { previewTokenFor } from '@/lib/preview-token';
import { AccountButton } from '@/components/storefront/account-button';
import { CartButton } from '@/components/storefront/cart-button';
import { TenantProvider } from '@/components/storefront/tenant-provider';
import { I18nProvider } from '@/components/storefront/i18n-provider';
import { LanguageToggle } from '@/components/storefront/language-toggle';
import { getDictionary, LOCALE_COOKIE, toLocale, type Locale } from '@/lib/i18n/dictionaries';
import { nameWordmarkStyle } from '@/lib/name-style';

/**
 * Title, description, and — the part that matters — whether Google is allowed to
 * index this at all.
 *
 * A QR-only restaurant asked us NOT to give them a website. Letting search engines
 * index the ordering terminal would hand them one anyway: a page that ranks for
 * their own name, that they never chose, cannot edit, and would find customers
 * arriving at from Google expecting a website. So it is noindexed.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;

  try {
    const restaurant = await storefrontApi.getRestaurant(slug);

    return {
      title: restaurant.name,
      description: restaurant.description ?? `Order from ${restaurant.name}`,
      robots: restaurant.orderingMode === 'QR_ONLY' ? { index: false, follow: false } : undefined,
    };
  } catch (err) {
    console.error(
      `Storefront metadata fetch failed for "${slug}":`,
      err instanceof ApiRequestError ? `status=${err.status} body=${JSON.stringify(err.body)}` : err,
    );
    return { title: 'Not found' };
  }
}

/**
 * The storefront shell for one restaurant.
 *
 * `[slug]` is populated by the middleware rewrite of `joes.dinedirect.manvion.ca` — the
 * customer never sees this path. The restaurant is fetched once here and handed
 * to the tree via context, so no child page re-fetches it.
 *
 * The tenant's brand colour is set as a CSS variable on the wrapper, which is how
 * every `bg-brand` in the subtree ends up the right colour without a single
 * inline style further down.
 */
export default async function StorefrontLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Carried only by staff who came through /preview-gate. For everyone else this
  // is undefined and the request is indistinguishable from public traffic.
  const previewToken = await previewTokenFor(slug);

  let restaurant;
  try {
    restaurant = await storefrontApi.getRestaurant(slug, previewToken);
  } catch (err) {
    // Unpublished, inactive or simply nonexistent — all indistinguishable to the
    // CUSTOMER, on purpose. A 404 must not confirm that a restaurant exists but
    // is offline. But that same swallow makes a real backend error (a bad query,
    // a missing column) indistinguishable from a real 404 in our OWN logs too --
    // so log the real reason server-side before presenting the generic page.
    console.error(
      `Storefront fetch failed for "${slug}":`,
      err instanceof ApiRequestError
        ? `status=${err.status} body=${JSON.stringify(err.body)}`
        : err,
    );
    notFound();
  }

  /**
   * How was this page reached?
   *
   * Via the tenant's own subdomain (`joes.dinedirect.manvion.ca`), the middleware rewrote the
   * request and the storefront IS the site root — internal links are plain `/menu`.
   *
   * Via `localhost/s/joes` — the only form that works on Windows, which cannot
   * resolve `*.localhost` — the storefront is mounted under a path, and `/menu`
   * would land on the platform root and 404. Every link needs the prefix.
   *
   * The middleware sets `x-restaurant-slug` only when it did a subdomain rewrite,
   * which makes it an exact signal for which of the two we're in.
   */
  const wasRewrittenFromSubdomain = Boolean((await headers()).get('x-restaurant-slug'));
  const basePath = wasRewrittenFromSubdomain ? '' : `/s/${slug}`;

  const href = (path: string) => `${basePath}${path === '/' ? '' : path}` || '/';

  /**
   * QR-only: this is not a website, it is an ordering terminal that happens to run
   * in a browser. The customer arrived by scanning a code at a table — they are not
   * browsing, and "About us" is not why they took their phone out. So the marketing
   * nav goes away, and the logo stops being a link to a homepage that redirects.
   *
   * "My orders" stays: closing the tab mid-order and having no way back is the one
   * failure that ends with them phoning the kitchen that is cooking their food.
   */
  const isQrOnly = restaurant.orderingMode === 'QR_ONLY';

  /**
   * Locale. The restaurant's content-language setting decides: a single language
   * pins it; BOTH lets the customer choose (persisted in a cookie) and shows the
   * toggle. Resolved server-side so the header/footer render in the right language
   * on first paint, then handed to the client provider for the interactive parts.
   */
  const canToggle = restaurant.menuLanguage === 'BOTH';
  const cookieLocale = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale =
    restaurant.menuLanguage === 'FR' ? 'fr' : canToggle ? toLocale(cookieLocale) : 'en';
  const t = getDictionary(locale);

  /**
   * The light/dark toggle the owner picks in Settings -> Branding, alongside
   * the template -- never a customer-facing switch. `.storefront-dark` (see
   * globals.css) flips the shared bg-background/text-foreground/bg-card/
   * border tokens that the header, footer, and every semantic-token template
   * (Classic, Minimal, Builder, Punchy) already read, so this one class is
   * the whole mechanism for those. Templates with their own hardcoded palette
   * (Rustic, Bento, Elegant) read restaurant.themeMode directly instead.
   */
  const themeClass = restaurant.themeMode === 'DARK' ? 'storefront-dark' : '';

  const content = (
    <TenantProvider restaurant={restaurant} basePath={basePath}>
      <I18nProvider initialLocale={locale} canToggle={canToggle}>
      <div
        style={
          {
            '--brand': restaurant.brandPrimaryColor,
            '--brand-foreground': '#ffffff',
          } as React.CSSProperties
        }
        className={`flex min-h-screen flex-col bg-background text-foreground ${themeClass}`}
      >
        {/* Staff preview of an unpublished page. Says so plainly, because the most
            expensive misunderstanding available here is an owner believing they are
            live while customers still get a 404. */}
        {previewToken && !restaurant.isPublished && (
          <div className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950">
            Preview — this page is not published yet. Customers can&apos;t see it until you hit
            Publish in your dashboard.
          </div>
        )}
        <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
          <div className="container flex min-h-16 items-center justify-between gap-4 py-2">
            <Link href={href(isQrOnly ? '/menu' : '/')} className="flex min-w-0 items-center gap-3">
              {/* NAME_ONLY needs no logo at all. LOGO_ONLY is only honored when a logo
                  actually exists -- a restaurant that picked it and then removed their
                  logo must still show SOMETHING, not a blank header. */}
              {restaurant.logoDisplayMode !== 'NAME_ONLY' &&
                (restaurant.logoUrl ? (
                  // Height-constrained, width auto and never cropped: a square icon
                  // shows square, a wide wordmark shows wide, both at a readable size.
                  // The base 44px height and 180px width scale by the restaurant's
                  // logoScale setting (50–250%), so a wide "logo + name" wordmark can be
                  // made large instead of being capped small. The header grows with it
                  // (min-h + padding) rather than clipping.
                  <span className="relative inline-flex shrink-0 items-center px-1">
                    {/* An organic brush-swipe of the brand colour behind the logo —
                        a hand-painted shade, not a square panel. Stretched across the
                        logo (fill scales; the streaks keep a constant width via
                        non-scaling-stroke) and kept faint so the logo stays legible. */}
                    {restaurant.logoBackdrop && (
                      <svg
                        viewBox="0 0 120 44"
                        preserveAspectRatio="none"
                        aria-hidden
                        className="pointer-events-none absolute -inset-x-3 -inset-y-1 z-0"
                        style={{ color: 'var(--brand)' }}
                      >
                        <path
                          d="M5 24 C 17 10, 39 14, 61 16 C 83 18, 105 8, 116 20 C 109 35, 82 30, 58 29 C 34 28, 13 38, 5 24 Z"
                          fill="currentColor"
                          opacity="0.14"
                        />
                        <path
                          d="M9 19 C 42 15, 80 14, 112 19"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                          opacity="0.2"
                        />
                        <path
                          d="M11 29 C 45 26, 78 27, 110 28"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                          opacity="0.14"
                        />
                      </svg>
                    )}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={restaurant.logoUrl}
                      alt={restaurant.name}
                      className="relative z-10 w-auto object-contain"
                      style={{
                        height: `${(restaurant.logoScale ?? 100) * 0.44}px`,
                        maxWidth: `${(restaurant.logoScale ?? 100) * 1.8}px`,
                      }}
                    />
                  </span>
                ) : (
                  <div
                    className="flex shrink-0 items-center justify-center rounded-xl bg-brand font-bold text-brand-foreground shadow-soft"
                    style={{
                      height: `${(restaurant.logoScale ?? 100) * 0.44}px`,
                      width: `${(restaurant.logoScale ?? 100) * 0.44}px`,
                      fontSize: `${(restaurant.logoScale ?? 100) * 0.18}px`,
                    }}
                  >
                    {restaurant.name.charAt(0)}
                  </div>
                ))}
              {(restaurant.logoDisplayMode !== 'LOGO_ONLY' || !restaurant.logoUrl) && (
                <span className="min-w-0 truncate leading-tight">
                  <span
                    className="block text-xl font-semibold tracking-tight"
                    style={nameWordmarkStyle(restaurant)}
                  >
                    {restaurant.name}
                  </span>
                  <span className="hidden text-[10px] font-semibold uppercase tracking-[0.18em] text-brand sm:block">
                    {restaurant.city}
                  </span>
                </span>
              )}
            </Link>

            <nav className="flex items-center gap-1">
              <Link
                href={href('/menu')}
                className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
              >
                {t.nav.menu}
              </Link>
              {!isQrOnly && (
                <Link
                  href={href('/about')}
                  className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
                >
                  {t.nav.about}
                </Link>
              )}
              {/* Party orders / catering — a paid capability. It sits inline with
                  the other nav links (no loud brand pill): present as an equal
                  option, not shouting for attention. */}
              {restaurant.cateringEnabled && (
                <Link
                  href={href('/catering')}
                  className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
                >
                  {t.nav.catering}
                </Link>
              )}
              {/* The way back to an order after closing the tab or losing the SMS.
                  Without it, the only route is phoning the kitchen that's cooking it. */}
              <Link
                href={href('/orders')}
                className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
              >
                {t.nav.myOrders}
              </Link>
              {/* EN/FR switch — only rendered for a BOTH restaurant. */}
              <LanguageToggle />
              {/* Optional, always. Guests never touch this and lose nothing. */}
              <AccountButton />
              <CartButton />
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t py-8">
          <div className="container space-y-1 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{restaurant.name}</p>
            <p>
              {restaurant.street}, {restaurant.city}, {restaurant.state}
            </p>
            <p>
              <a href={`tel:${restaurant.phone}`} className="hover:underline">
                {restaurant.phone}
              </a>
            </p>
            {!restaurant.removeBranding && (
              <p className="pt-4 text-xs">Powered by DineDirect</p>
            )}
          </div>
        </footer>
      </div>
      </I18nProvider>
    </TenantProvider>
  );

  // The customer-facing sign-in / sign-up modals must carry the RESTAURANT's name,
  // never the platform's Clerk application name ("restro"). A storefront-scoped
  // ClerkProvider overrides the root one's localization for this subtree. When Clerk
  // isn't configured, the storefront still renders for guests exactly as before.
  const clerkEnabled = Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_'),
  );
  if (!clerkEnabled) return content;

  return (
    <ClerkProvider
      localization={{
        signIn: {
          start: {
            title: `Sign in to ${restaurant.name}`,
            subtitle: `Welcome back to ${restaurant.name}`,
          },
        },
        signUp: {
          start: {
            title: `Create your ${restaurant.name} account`,
            subtitle: `Order faster next time at ${restaurant.name}`,
          },
        },
      }}
    >
      {content}
    </ClerkProvider>
  );
}
