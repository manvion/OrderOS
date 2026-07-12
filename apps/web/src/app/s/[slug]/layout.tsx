import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { storefrontApi } from '@/lib/api';
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
  } catch {
    return { title: 'Not found' };
  }
}

/**
 * The storefront shell for one restaurant.
 *
 * `[slug]` is populated by the middleware rewrite of `joes.orderos.ai` — the
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

  let restaurant;
  try {
    restaurant = await storefrontApi.getRestaurant(slug);
  } catch {
    // Unpublished, inactive or simply nonexistent — all indistinguishable, on
    // purpose. A 404 must not confirm that a restaurant exists but is offline.
    notFound();
  }

  /**
   * How was this page reached?
   *
   * Via the tenant's own subdomain (`joes.orderos.ai`), the middleware rewrote the
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

  return (
    <TenantProvider restaurant={restaurant} basePath={basePath}>
      <div
        style={
          {
            '--brand': restaurant.brandPrimaryColor,
            '--brand-foreground': '#ffffff',
          } as React.CSSProperties
        }
        className="flex min-h-screen flex-col bg-background"
      >
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
          <div className="container flex h-16 items-center justify-between gap-4">
            <Link href={href(isQrOnly ? '/menu' : '/')} className="flex min-w-0 items-center gap-3">
              {restaurant.logoUrl ? (
                <Image
                  src={restaurant.logoUrl}
                  alt={restaurant.name}
                  width={36}
                  height={36}
                  className="h-9 w-9 rounded-md object-cover"
                />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand text-sm font-bold text-brand-foreground">
                  {restaurant.name.charAt(0)}
                </div>
              )}
              <span className="truncate font-semibold">{restaurant.name}</span>
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
            <p className="pt-4 text-xs">Powered by OrderOS</p>
          </div>
        </footer>
      </div>
    </TenantProvider>
  );
}
