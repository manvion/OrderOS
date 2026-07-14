'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { storefrontApi, type StorefrontRestaurant } from '@/lib/api';
import { CustomerAuthProvider } from './customer-auth';
import { useCart } from '@/lib/cart-store';

interface TenantContextValue {
  restaurant: StorefrontRestaurant;
  /**
   * Prefix for every internal storefront link.
   *
   * On a real subdomain (`joes.dinedirect.manvion.ca`) the storefront IS the site root, so
   * this is `''` and links are plain `/menu`, `/cart`.
   *
   * On `localhost/s/joes` — the only form that works on Windows, which cannot
   * resolve `*.localhost` — the storefront is mounted under a path, so the same
   * link must be `/s/joes/menu`. Hardcoding `/menu` sends you to the platform root
   * and 404s, which is exactly what happened.
   */
  basePath: string;
}

const TenantContext = createContext<TenantContextValue | null>(null);

/** The current restaurant. Throws if used outside a storefront route — which is a bug. */
export function useTenant(): StorefrontRestaurant {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenant must be used inside a storefront route');
  return ctx.restaurant;
}

/**
 * Build an internal storefront link. ALWAYS use this instead of a bare `/menu`.
 *
 *   const href = useTenantHref();
 *   <Link href={href('/menu')}>
 */
export function useTenantHref(): (path: string) => string {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error('useTenantHref must be used inside a storefront route');
  return (path: string) => `${ctx.basePath}${path === '/' ? '' : path}` || '/';
}

export function TenantProvider({
  restaurant,
  basePath,
  children,
}: {
  restaurant: StorefrontRestaurant;
  /** '' on a real subdomain; '/s/<slug>' when mounted under a path. */
  basePath: string;
  children: React.ReactNode;
}) {
  // The storefront needs a QueryClient for the (entirely optional) customer
  // account: the profile lookup and the saved-address list. A guest never
  // triggers a single query through it.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false } },
      }),
  );

  const ensureRestaurant = useCart((s) => s.ensureRestaurant);
  const setTableContext = useCart((s) => s.setTableContext);
  const searchParams = useSearchParams();

  // Reset a cart carried over from a different restaurant. The cart is persisted
  // in localStorage, which is shared across subdomains in dev — without this, a
  // cart from Bella's would appear on Joe's and every line would 400 at checkout.
  useEffect(() => {
    ensureRestaurant(restaurant.slug);
  }, [restaurant.slug, ensureRestaurant]);

  // QR arrival: ?src=qr&c=<qrCodeId>&t=<table>. Record the scan for attribution
  // and pre-set the table so a dine-in customer never has to type it in.
  useEffect(() => {
    if (searchParams.get('src') !== 'qr') return;

    const qrCodeId = searchParams.get('c');
    const tableNumber = searchParams.get('t');

    if (tableNumber || qrCodeId) {
      setTableContext(tableNumber, qrCodeId);
    }
    if (qrCodeId) {
      void storefrontApi.registerScan(qrCodeId);
    }
  }, [searchParams, setTableContext]);

  return (
    <QueryClientProvider client={queryClient}>
      <CustomerAuthProvider>
        <TenantContext.Provider value={{ restaurant, basePath }}>
          {children}
        </TenantContext.Provider>
      </CustomerAuthProvider>
    </QueryClientProvider>
  );
}
