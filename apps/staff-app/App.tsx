import React, { useEffect } from 'react';
import { ClerkProvider, useAuth } from '@clerk/clerk-expo';
import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import { tokenCache } from './src/auth/token-cache';
import { fetchConnectionToken, setAuthTokenProvider } from './src/lib/api';
import { SignInScreen } from './src/SignInScreen';
import { PosApp } from './src/PosApp';

const CLERK_KEY = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

/**
 * Root of the DineDirect staff app.
 *
 * Two providers wrap everything:
 *   - ClerkProvider: the SAME auth as the web dashboard. Staff sign in with their existing
 *     account; the API resolves which restaurant they act for from that session.
 *   - StripeTerminalProvider: its tokenProvider is the only Stripe path, calling our API's
 *     connection-token endpoint. No Stripe secret ever lives in the app.
 *
 * Gate wires the signed-in session's token into the API layer, then shows either sign-in
 * or the POS. Nothing can be charged until someone is signed in.
 */
export default function App() {
  return (
    <ClerkProvider publishableKey={CLERK_KEY} tokenCache={tokenCache}>
      <StripeTerminalProvider logLevel="verbose" tokenProvider={fetchConnectionToken}>
        <Gate />
      </StripeTerminalProvider>
    </ClerkProvider>
  );
}

function Gate() {
  const { isLoaded, isSignedIn, getToken } = useAuth();

  // Every API call carries the staff member's Clerk token; this is where it's supplied.
  useEffect(() => {
    setAuthTokenProvider(() => getToken());
  }, [getToken]);

  if (!isLoaded) return null;
  return isSignedIn ? <PosApp /> : <SignInScreen />;
}
