import React from 'react';
import { StripeTerminalProvider } from '@stripe/stripe-terminal-react-native';
import { fetchConnectionToken } from './src/lib/api';
import { PaymentScreen } from './src/PaymentScreen';

/**
 * Root of the DineDirect staff app.
 *
 * The whole app is wrapped in StripeTerminalProvider, whose `tokenProvider` is the ONLY
 * Stripe secret path: it calls our API's /payments/terminal/connection-token, which mints
 * the token on the restaurant's connected account. No Stripe secret ever lives in the app.
 *
 * In a fuller build this is where sign-in (Clerk) and restaurant selection would live,
 * wiring setAuthTokenProvider() and setRestaurant() before any charge. Kept to the payment
 * flow here so the Terminal integration is easy to read.
 */
export default function App() {
  return (
    <StripeTerminalProvider logLevel="verbose" tokenProvider={fetchConnectionToken}>
      <PaymentScreen />
    </StripeTerminalProvider>
  );
}
