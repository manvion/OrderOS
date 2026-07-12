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

export const useAuthToken: () => { getToken: () => Promise<string | null> } = CLERK_ENABLED
  ? useAuth
  : () => ({ getToken: async () => 'no-clerk' });
