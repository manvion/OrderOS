'use client';

import { SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/nextjs';
import { useQuery } from '@tanstack/react-query';
import { User } from 'lucide-react';
import { storefrontApi } from '@/lib/api';
import { useTenant } from './tenant-provider';
import { CLERK_ENABLED, useCustomerAuth } from './customer-auth';

/**
 * The customer's account control in the storefront header.
 *
 * Deliberately quiet: a small "Sign in" link, never a modal, never a wall, never a
 * nag. The moment a restaurant's ordering page interrupts someone to make an
 * account, that person goes back to the marketplace app where they're already
 * logged in. The account is a reward for coming back, not a toll for arriving.
 *
 * Renders NOTHING when Clerk isn't configured — the storefront must work for
 * guests on a deployment with no auth at all, and a sign-in button that cannot
 * sign anyone in is worse than no button.
 */
export function AccountButton({ dark = false }: { dark?: boolean }) {
  if (!CLERK_ENABLED) return null;
  return <AccountButtonInner dark={dark} />;
}

function AccountButtonInner({ dark }: { dark: boolean }) {
  const restaurant = useTenant();
  const { getToken, isSignedIn } = useCustomerAuth();

  const { data: profile } = useQuery({
    queryKey: ['storefront-profile', restaurant.slug],
    queryFn: async () => {
      const token = await getToken();
      if (!token) return null;
      return storefrontApi.getProfile(restaurant.slug, token);
    },
    enabled: isSignedIn,
    staleTime: 5 * 60_000,
  });

  return (
    <>
      <SignedOut>
        <SignInButton mode="modal">
          <button
            className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              dark
                ? 'text-white/60 hover:bg-white/10 hover:text-white'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            }`}
          >
            <User className="h-4 w-4" />
            <span className="hidden sm:inline">Sign in</span>
          </button>
        </SignInButton>
      </SignedOut>

      <SignedIn>
        <div className="flex items-center gap-2">
          {/* Recognise a regular. It costs nothing, and it is the clearest signal
              that this is the restaurant's own place rather than a marketplace. */}
          {profile && profile.customer.totalOrders > 0 && (
            <span className={`hidden text-xs sm:inline ${dark ? 'text-white/50' : 'text-muted-foreground'}`}>
              {profile.customer.totalOrders} order
              {profile.customer.totalOrders === 1 ? '' : 's'} with us
            </span>
          )}
          <UserButton appearance={{ elements: { avatarBox: 'h-8 w-8' } }} userProfileMode="modal" />
        </div>
      </SignedIn>
    </>
  );
}
