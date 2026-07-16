'use client';

import { useAuth } from '@clerk/nextjs';

/**
 * `useAuth()` from Clerk THROWS when there is no publishable key, taking the whole
 * page down with it. On the storefront that would mean an auth outage stops burgers
 * being sold; on the platform console it means a blank white screen instead of a
 * page that could at least tell you what's wrong.
 *
 * So the hook is chosen ONCE, at module load, from a build-time constant — the hook
 * order is therefore identical on every render, which is what the rules of hooks
 * actually require.
 *
 * This unlocks nothing. The stub token is meaningless, and every admin call is
 * authorised server-side against the PlatformAdmin table. With no real session,
 * `adminMe` 401s and the console renders "Not found" — exactly what a stranger
 * poking at /admin should see.
 */
export const CLERK_ENABLED = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.startsWith('pk_'),
);

export interface AuthTokenState {
  getToken: () => Promise<string | null>;
  /**
   * Has Clerk finished loading in the browser? Until it has, `getToken()` returns
   * null even for a signed-in admin — so a query that fires before this is true
   * gets a spurious 401. Callers gate on it. Always true for the no-Clerk stub.
   */
  isLoaded: boolean;
  isSignedIn: boolean;
}

/** Wraps Clerk's useAuth so the hook is called unconditionally (stable hook order). */
function useClerkAuthToken(): AuthTokenState {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  return { getToken, isLoaded, isSignedIn: Boolean(isSignedIn) };
}

export const useAuthToken: () => AuthTokenState = CLERK_ENABLED
  ? useClerkAuthToken
  : () => ({ getToken: async () => 'no-clerk', isLoaded: true, isSignedIn: true });
