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

## App flow

1. **Sign in** (`src/SignInScreen.tsx`) — the staff member's existing DineDirect account
   (Clerk). The API resolves which restaurant they act for from that session.
2. **Pick an unpaid order** (`src/PosApp.tsx`) — a live list from `GET /orders/awaiting-payment`,
   scoped to their restaurant. Tap to Pay connects once, up front.
3. **Charge** (`src/ChargeSheet.tsx`) — the five-step Terminal dance for that order:
   - `createTerminalIntent(orderId)` → our API → `clientSecret`
   - `retrievePaymentIntent(clientSecret)`
   - `collectPaymentMethod(...)` — **the customer taps their card**
   - `confirmPaymentIntent(...)` — captures
   - `settleTerminalOrder(orderId)` → our API re-reads the intent from Stripe and marks the
     order paid (the app never marks anything paid itself).

## How staff get the app

Each restaurant has a **"Payment app" QR** on its dashboard (Staff access). Staff scan it
and land on `/get-app?r=<restaurant-slug>`, which detects their phone and hands them the
right install (Android download, or the App Store on iPhone), then they sign in.

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

Environment (set in `.env` / EAS secrets — both are baked at build for Expo public vars):

- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` — the **same** Clerk key the web app uses (`pk_…`).
- `EXPO_PUBLIC_API_URL` — your API base (defaults to `https://api.dinedirect.manvion.ca`).

Sign-in and the order list are wired. Multi-restaurant staff (a person at more than one
location) still need a location picker — `setActiveRestaurant(id)` exists in `src/lib/api.ts`
for that; single-restaurant staff need nothing, since the API defaults to their one membership.

## Cloud builds (EAS — no Mac needed)

`eas.json` defines the profiles. Build in Expo's cloud and install the result:

```bash
npm install -g eas-cli && eas login
eas build --platform android --profile preview   # → an installable .apk (host it, QR to it)
eas build --platform ios --profile production     # → App Store (needs Apple Dev + Tap-to-Pay entitlement)
```

Android `preview` produces a direct-install APK — the file the `/get-app` page serves for
Android. iOS must go through the App Store (Apple gives Tap-to-Pay apps no other route).

## Requirements / caveats

- **Tap to Pay on iPhone**: iPhone XS or later, iOS 16.7+, and Apple approval for the
  `proximity-reader.payment.acceptance` entitlement (request it in your Apple Developer
  account). Physical device only.
- **Tap to Pay on Android**: NFC device, Android 11+, Google Play Services.
- **Stripe**: the restaurant must have completed Stripe Connect onboarding with charges
  enabled (the same status the dashboard shows). Terminal must be enabled on your Stripe
  account.
- **SDK version**: pinned to `@stripe/stripe-terminal-react-native@0.0.1-beta.31` and the
  app is typechecked against it (`connectReader({ discoveryMethod: 'tapToPay', reader,
  locationId, ... })`). Tap to Pay's API shifts between beta releases, so re-typecheck if you
  bump the version. `.npmrc` sets `legacy-peer-deps=true` (Clerk pulls a react-dom peer that
  trips npm against Expo's react) — required for `npm install` and EAS to succeed.
