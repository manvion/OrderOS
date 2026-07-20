# Webhook setup — Stripe & Uber Direct

The handlers are already implemented and verify every request's signature before
touching the payload. You only need to (1) register each endpoint in the provider's
dashboard and (2) set the signing secret as an env var on the **API** service (Railway).

Replace `API_URL` below with your API's public base URL (the Railway service URL, e.g.
`https://your-api.up.railway.app`, or `https://api.dinedirect.manvion.ca` if you've
mapped a custom domain). It is **not** the website URL.

---

## Stripe

- **Endpoint URL:** `API_URL/api/payments/webhook`
- **Method:** POST
- **Signature header:** `stripe-signature` (Stripe sends this automatically)
- **Env var to set:** `STRIPE_WEBHOOK_SECRET` = the `whsec_…` signing secret Stripe shows
  after you create the endpoint.

### Events to enable

The handler processes these — enable exactly this set:

**Orders (Connect / destination charges):**
- `checkout.session.completed` ← marks an order **paid** (the critical one)
- `checkout.session.expired`
- `payment_intent.payment_failed`
- `charge.refunded`
- `account.updated` ← restaurant Stripe-Connect onboarding status

**Subscription billing (your SaaS revenue):**
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

### Steps

1. Stripe Dashboard → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL = `API_URL/api/payments/webhook`.
3. Select the events above (or "Select all" is fine — extras are ignored).
4. If you use Stripe **Connect**, also add a **Connect** endpoint (same URL) so
   `account.updated` for connected accounts arrives.
5. Copy the **Signing secret** (`whsec_…`) → set `STRIPE_WEBHOOK_SECRET` on the API
   service → redeploy.
6. Use **"Send test webhook"** (`checkout.session.completed`) to confirm a `200`.

> Note: even without the webhook, a paid order is confirmed on the return-from-Stripe
> page as a fallback — but the webhook is the reliable source of truth and is required
> for refunds and subscription billing.

---

## Uber Direct

- **Endpoint URL:** `API_URL/api/delivery/webhook`
- **Method:** POST
- **Signature header:** `x-postmates-signature` (HMAC-SHA256 of the raw body; Uber
  Direct still uses the legacy Postmates header name)
- **Env var to set:** `UBER_WEBHOOK_SECRET` = the signing secret from the Uber Direct
  dashboard/app.

### Steps

1. Uber Direct dashboard → your app → **Webhooks**.
2. Add a webhook with URL `API_URL/api/delivery/webhook`.
3. Subscribe to **delivery status** events (courier assigned, picked up, dropped off,
   etc.) — the handler maps them to the order's delivery status and live map.
4. Copy the **signing secret** → set `UBER_WEBHOOK_SECRET` on the API service →
   redeploy.

> The handler **rejects** any request whose HMAC doesn't match (403), and refuses all
> webhooks if `UBER_WEBHOOK_SECRET` is unset — so set the secret before you point Uber
> at the endpoint, or every event will be dropped.

---

## Quick verification

After setting the secrets and redeploying the API:

- Stripe: "Send test webhook" → expect `200 { "received": true }`.
- Uber: place a sandbox delivery (if `UBER_SANDBOX_MODE=true`) and watch the order's
  delivery status update as events arrive.
- A `403 Invalid webhook signature` means the secret doesn't match what the provider
  is signing with — re-copy it.
- A `400 Raw body unavailable` should never happen (raw-body capture is wired in
  `apps/api/src/main.ts` for both paths); if it does, the API didn't start cleanly.
