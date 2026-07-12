'use client';

import { createContext, useContext } from 'react';
import { useAuth } from '@clerk/nextjs';

/**
 * Optional customer auth, decoupled from Clerk.
 *
 * The storefront is the thing that takes money, and it must render for a guest
 * with NO auth provider present at all — because:
 *
 *  - a customer buying a burger has no account and needs none;
 *  - a Clerk outage, or a bad key, must not take down every restaurant's ordering
 *    page along with it;
 *  - and calling Clerk's hooks with no ClerkProvider mounted throws, which would
 *    turn "auth is misconfigured" into "nobody can buy food".
 *
 * So nothing in the storefront calls a Clerk hook directly. They read this context
 * instead. When Clerk is configured, `ClerkBridge` fills it in. When it isn't, the
 * context is simply empty and every consumer behaves as if the customer is a guest
 * — which is the correct and safe default.
 *
 * The conditional is at the PROVIDER, not at the hook: consumers always call
 * `useContext`, so the rules of hooks are never bent.
 */
interface CustomerAuth {
  isSignedIn: boolean;
  /** Returns null for a guest, or when Clerk isn't configured. */
  getToken: () => Promise<string | null>;
}

const GUEST: CustomerAuth = {
  isSignedIn: false,
  getToken: async () => null,
};

const CustomerAuthContext = createContext<CustomerAuth>(GUEST);

export function useCustomerAuth(): CustomerAuth {
  return useContext(CustomerAuthContext);
}

/** True only when a real Clerk key is present at build time. */
export const CLERK_ENABLED = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_'),
);

export function CustomerAuthProvider({ children }: { children: React.ReactNode }) {
  // No Clerk? Everyone is a guest, and no Clerk hook is ever called.
  if (!CLERK_ENABLED) {
    return <CustomerAuthContext.Provider value={GUEST}>{children}</CustomerAuthContext.Provider>;
  }

  return <ClerkBridge>{children}</ClerkBridge>;
}

/**
 * Only ever mounted when Clerk is configured, so `useAuth()` here is always safe.
 */
function ClerkBridge({ children }: { children: React.ReactNode }) {
  const { isSignedIn, getToken } = useAuth();

  return (
    <CustomerAuthContext.Provider
      value={{
        isSignedIn: Boolean(isSignedIn),
        getToken: async () => {
          try {
            return await getToken();
          } catch {
            // An expired or broken session must not fail a checkout. Treat it as a
            // guest and let them buy their food.
            return null;
          }
        },
      }}
    >
      {children}
    </CustomerAuthContext.Provider>
  );
}
