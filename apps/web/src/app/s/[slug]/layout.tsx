import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { ApiRequestError, storefrontApi } from '@/lib/api';
import { previewTokenFor } from '@/lib/preview-token';
import { AccountButton } from '@/components/storefront/account-button';
import { CartButton } from '@/components/storefront/cart-button';
import { TenantProvider } from '@/components/storefront/tenant-provider';

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
   * The light/dark toggle the owner picks in Settings -> Branding, alongside
   * the template -- never a customer-facing switch. `.storefront-dark` (see
   * globals.css) flips the shared bg-background/text-foreground/bg-card/
   * border tokens that the header, footer, and every semantic-token template
   * (Classic, Minimal, Builder, Punchy) already read, so this one class is
   * the whole mechanism for those. Templates with their own hardcoded palette
   * (Rustic, Bento, Elegant) read restaurant.themeMode directly instead.
   */
  const themeClass = restaurant.themeMode === 'DARK' ? 'storefront-dark' : '';

  return (
    <TenantProvider restaurant={restaurant} basePath={basePath}>
      <div
        style={
          {
            '--brand': restaurant.brandPrimaryColor,
            '--brand-foreground': '#ffffff',
          } as React.CSSProperties
        }
        className={`flex min-h-screen flex-col bg-background ${themeClass}`}
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
          <div className="container flex h-16 items-center justify-between gap-4">
            <Link href={href(isQrOnly ? '/menu' : '/')} className="flex min-w-0 items-center gap-3">
              {/* NAME_ONLY needs no logo at all. LOGO_ONLY is only honored when a logo
                  actually exists -- a restaurant that picked it and then removed their
                  logo must still show SOMETHING, not a blank header. */}
              {restaurant.logoDisplayMode !== 'NAME_ONLY' &&
                (restaurant.logoUrl ? (
                  <Image
                    src={restaurant.logoUrl}
                    alt={restaurant.name}
                    width={40}
                    height={40}
                    className="h-10 w-10 rounded-xl border object-cover shadow-soft"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-base font-bold text-brand-foreground shadow-soft">
                    {restaurant.name.charAt(0)}
                  </div>
                ))}
              {(restaurant.logoDisplayMode !== 'LOGO_ONLY' || !restaurant.logoUrl) && (
                <span className="min-w-0 truncate leading-tight">
                  <span className="block font-display text-xl font-semibold tracking-tight">
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
                Menu
              </Link>
              {!isQrOnly && (
                <Link
                  href={href('/about')}
                  className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
                >
                  About
                </Link>
              )}
              {/* The way back to an order after closing the tab or losing the SMS.
                  Without it, the only route is phoning the kitchen that's cooking it. */}
              <Link
                href={href('/orders')}
                className="hidden rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:block"
              >
                My orders
              </Link>
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
            <p className="pt-4 text-xs">Powered by DineDirect</p>
          </div>
        </footer>
      </div>
    </TenantProvider>
  );
}
