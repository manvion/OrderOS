# DineDirect Staff app — in-person card payments (Tap to Pay)

A small React Native (Expo) app that lets counter staff take **card-present** payments on
their own phone via **Stripe Terminal's Tap to Pay** — no reader hardware. It's the surface
the web dashboard can't provide, because Tap to Pay uses the phone's NFC through Stripe's
native SDK, which a browser can't reach.

The app is deliberately thin: it holds **no Stripe secret**. It talks only to three
DineDirect API endpoints, which do all the Stripe work on the restaurant's connected
account:

| App action | API endpoint | What it does |
|---|---|---|
| SDK asks for a connection token | `POST /api/payments/terminal/connection-token` | Mints a Terminal token on the restaurant's Stripe account |
| Start a charge | `POST /api/payments/terminal/orders/:orderId/intent` | Creates the card-present PaymentIntent, returns its client secret |
| After the tap | `POST /api/payments/terminal/orders/:orderId/settle` | Re-reads the intent from Stripe, marks the order **paid**, records the fee |

> **Why the money is safe:** the app never marks anything paid. The `/settle` endpoint
> retrieves the PaymentIntent from Stripe and only flips the order to PAID if Stripe itself
> says it succeeded. The app is a UI over Stripe's own SDK.

## Payment flow (see `src/PaymentScreen.tsx`)

1. `initialize()` + `discoverReaders({ discoveryMethod: 'tapToPay' })` — the phone becomes the reader.
2. `createTerminalIntent(orderId)` → our API → `clientSecret`.
3. `retrievePaymentIntent(clientSecret)`.
4. `collectPaymentMethod(...)` — **the customer taps their card.**
5. `confirmPaymentIntent(...)` — captures.
6. `settleTerminalOrder(orderId)` → our API marks the order paid.

## Setup

This is a **scaffold**: the payment integration is complete, but it needs installing and a
native build (Tap to Pay can't run in Expo Go — it requires a dev/production build).

```bash
cd apps/staff-app
npm install
# iOS Tap to Pay needs the entitlement (already in app.json) + a paid Apple Developer
# account approved for Tap to Pay on iPhone, and a physical device (no simulator).
npx expo prebuild
npx expo run:ios      # or: npx expo run:android
```

Configure at runtime before charging:

- `EXPO_PUBLIC_API_URL` — your API base (defaults to `https://api.dinedirect.manvion.ca`).
- `setAuthTokenProvider(fn)` — return the signed-in staff member's Clerk bearer token.
- `setRestaurant(slug)` — the restaurant whose till this device rings up.

(Sign-in and restaurant selection are intentionally left out of this scaffold — wire them
in `App.tsx` before shipping. Everything payment-related is done.)

## Requirements / caveats

- **Tap to Pay on iPhone**: iPhone XS or later, iOS 16.7+, and Apple approval for the
  `proximity-reader.payment.acceptance` entitlement (request it in your Apple Developer
  account). Physical device only.
- **Tap to Pay on Android**: NFC device, Android 11+, Google Play Services.
- **Stripe**: the restaurant must have completed Stripe Connect onboarding with charges
  enabled (the same status the dashboard shows). Terminal must be enabled on your Stripe
  account.
- **SDK version**: method names for Tap to Pay have shifted across `@stripe/stripe-terminal-react-native`
  beta releases (`connectLocalMobileReader` → `connectReader(..., 'tapToPay')`). Pin the
  version in `package.json` and adjust `connectReader`/`discoverReaders` calls to match if
  you upgrade.
