# DineDirect

Direct ordering for restaurants. Each restaurant gets a branded ordering site at
`theirname.dinedirect.manvion.ca` — pickup, delivery and QR table ordering — with Stripe
payments and Uber Direct couriers, and no marketplace taking a third of every order.

---

## What's here

```
dinedirect/
├── apps/
│   ├── api/                  NestJS + Prisma + PostgreSQL + Redis
│   │   ├── prisma/
│   │   │   ├── schema.prisma      17 models, every tenant-scoped table carries restaurantId
│   │   │   ├── migrations/        initial migration, applied by `migrate deploy` at boot
│   │   │   └── seed.ts            one fully-onboarded demo restaurant
│   │   └── src/
│   │       ├── config/env.ts               env contract — the app refuses to boot if it's wrong
│   │       ├── common/
│   │       │   ├── auth/                   Clerk verification, RBAC, tenant guards
│   │       │   ├── audit/                  who did what, on every mutation
│   │       │   ├── prisma/  redis/         infrastructure
│   │       │   ├── filters/                error envelope; never leaks a stack trace
│   │       │   └── pipes/                  Zod validation, shared with the web forms
│   │       └── modules/
│   │           ├── restaurants/            onboarding, settings, staff, publishing
│   │           ├── menu/                   categories, products, modifier groups
│   │           ├── orders/                 pricing, state machine, tracking
│   │           ├── payments/               Stripe Checkout, Connect, webhooks, refunds
│   │           ├── delivery/               Uber Direct: quote, dispatch, webhooks, retry queue
│   │           ├── qr/                     table / counter / flyer codes + scan attribution
│   │           ├── notifications/          Twilio SMS, Resend email
│   │           ├── storefront/             the only surface customers touch
│   │           ├── analytics/  customers/  dashboard reads
│   │           └── storage/                Azure Blob (local disk fallback in dev)
│   │
│   └── web/                  Next.js 15 (App Router) + Tailwind + shadcn
│       ├── middleware.ts           subdomain -> tenant rewrite; the multi-tenant front door
│       └── src/
│           ├── app/
│           │   ├── s/[slug]/       the storefront (rewrite target — never visited directly)
│           │   ├── dashboard/      the restaurant's back office
│           │   └── onboarding/     step 1: create the restaurant
│           ├── components/
│           └── lib/
│               ├── api.ts          typed client; storefront + dashboard flavours
│               └── cart-store.ts   Zustand cart, priced by the SHARED engine
│
├── packages/shared/          Types, Zod schemas, business hours — and the pricing engine
│   └── src/pricing.ts        Imported by BOTH the browser cart and the API. One source of truth.
│
├── integrations/            Embeddable widget for restaurants that already have a website
│   ├── wordpress/dinedirect/        WordPress plugin (settings screen + shortcodes)
│   └── test/plain-html.html      Deliberately hostile test page (see docs/WIDGET.md)
│
├── docs/WIDGET.md
├── docker-compose.yml
└── .env.example
```

## Two ways a restaurant takes orders

**A hosted storefront** at `theirname.dinedirect.manvion.ca` — for restaurants with no website,
or who want a better one.

**An embedded widget** on the website they already have — WordPress, Wix,
Squarespace, hand-written HTML. One `<script>` tag, and customers order and pay
without ever leaving their site. See **[docs/WIDGET.md](docs/WIDGET.md)**.

Both funnel into the same order pipeline: the same pricing engine, the same state
machine, the same kitchen board. The widget is a second front door, not a second
product.

---

## Run it locally

**Prerequisites:** Node 20+, Docker, and a Clerk + Stripe test account.

```bash
# 1. Config
cp .env.example .env
#    Fill in at minimum: CLERK_SECRET_KEY, CLERK_PUBLISHABLE_KEY,
#    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
#    Everything else has a working default or degrades gracefully.

# 2. Infrastructure
npm run infra:up          # postgres + redis

# 3. Install, migrate, seed
npm install
npm run db:migrate        # creates the schema
npm run db:seed           # one demo restaurant: Bella Burger

# 4. Go
npm run dev               # api on :4000, web on :3000
```

| What | Where |
|---|---|
| Demo storefront | http://localhost:3000/s/bellaburger |
| Restaurant dashboard | http://localhost:3000/dashboard |
| API docs (Swagger) | http://localhost:4000/docs |
| Health check | http://localhost:4000/health/ready |

### About that storefront URL

In production a restaurant lives on a real subdomain (`joes.dinedirect.manvion.ca`), and the
middleware maps that to `/s/joes`. Locally, use the **`/s/<slug>` path** instead.

Do **not** rely on `joes.localhost:3000`. It works in some browsers and not others,
and on **Windows it does not resolve at all** — the OS resolver simply fails, so you
get a dead hostname and conclude the app is broken. (It did exactly that to us.)

`/s/<slug>` is the same page through the same code path, and works on every OS with
no hosts-file surgery. The middleware only permits it when the host is `localhost`,
so on the real apex domain it still 404s.

### Stripe webhooks in development

Checkout only completes when the webhook fires. Without this, orders stay `PENDING`
forever and never reach the kitchen board:

```bash
stripe listen --forward-to localhost:4000/api/payments/webhook
# Copy the printed whsec_… into STRIPE_WEBHOOK_SECRET and restart the API.
```

---

## The decisions worth knowing about

**Money is never a float.** Every amount is an integer count of cents, all the way
through the database, the API and the UI. `packages/shared/src/pricing.ts` is the
only thing that computes a total, and both the browser cart and the server import
it — so the number the customer sees and the number Stripe charges are produced by
the same lines of code.

**The client never sends a price.** The cart posts product ids and modifier ids.
The API reads every price from the database and re-runs the pricing engine. A
crafted request asking for a one-cent lobster gets billed for a lobster.

**A tenant can't name another tenant.** `restaurantId` comes from the caller's
server-side membership row (dashboard) or the subdomain (storefront) — never from a
body field, query param or header the client controls. Cross-tenant access isn't
"prevented by a check"; there's no code path that could express it.

**Webhooks are authenticated, then made idempotent.** Stripe signatures and Uber's
HMAC are verified against the *raw* bytes before the payload is parsed (see
`main.ts`, where JSON parsing is disabled for those two routes — a re-serialized
body has a different signature). Every event id is then inserted into
`WebhookEvent`, so a retry can't charge twice or send a second text.

**Kitchen reality doesn't depend on Uber's uptime.** Marking an order READY always
succeeds. If the courier dispatch fails, the order is still ready, the failure is
recorded, and the retry queue backs off (30s → 8m, five attempts). Staff see a
warning telling them to arrange their own driver — rather than a spinner and a bag
of food going cold.

**Permanent failures don't get retried.** The Uber client distinguishes 4xx
("that address is undeliverable" — will never work) from 5xx and timeouts
("try again"). Only the second kind goes on the queue.

**The widget key is public, and that's fine.** It ships in the restaurant's page
source. What authorises a widget request is the pair `(key, Origin)` — the browser
sets `Origin` and a page cannot forge it, so a key scraped from one site and pasted
into another produces an Origin that isn't on the allowlist and is refused, at the
CORS layer and again at the guard. Registering `joes.com` deliberately does *not*
authorise `*.joes.com`: on shared hosts like `wixsite.com`, a sibling subdomain is
someone else's business entirely.

---

## Order lifecycle

```
Customer pays  →  PENDING     ← invisible to the kitchen until Stripe confirms
Restaurant     →  ACCEPTED       (SMS + email receipt to the customer)
               →  PREPARING
               →  READY       ← delivery orders dispatch an Uber courier here
Uber           →  DRIVER_ASSIGNED   (SMS with the courier's name + live map)
               →  OUT_FOR_DELIVERY
               →  DELIVERED
```

Pickup and dine-in skip the courier states: `READY → COMPLETED`.

The legal transitions live in `packages/shared/src/enums.ts` (`ORDER_TRANSITIONS`)
and are enforced in exactly one place — `OrdersService.transition()`. The dashboard,
the Stripe webhook and the Uber webhook all funnel through it, so there is no second
opinion about what an order is allowed to do next.

---

## Testing

```bash
npm test --workspace=@dinedirect/api     # 16 unit tests
```

Covers the three places where a bug costs real money or real food: the pricing
engine (modifier maths, tax base, discount clamping, rounding), the order state
machine (no skipping the kitchen, no resurrecting a delivered order), and business
hours (timezones, overnight windows, split shifts).

### Manual end-to-end

1. `npm run db:seed`, then open http://localhost:3000/s/bellaburger
2. Add "The Classic" — it has a required **Size** group and an optional **Extras**
   group, the exact structure from the spec.
3. Check out with Stripe test card `4242 4242 4242 4242`.
4. With `stripe listen` running, the order appears on
   http://localhost:3000/dashboard/orders within ten seconds.
5. Accept → Preparing → Ready. Watch the tracking page update itself.

---

## Deploying to Azure

Both images build clean and run as non-root:

```bash
docker compose --profile full up --build
```

For Azure Container Apps:

1. **Postgres** — Azure Database for PostgreSQL Flexible Server. Put its connection
   string in `DATABASE_URL`. Migrations run automatically on container start
   (`prisma migrate deploy`, which only ever applies — it never resets).
2. **Redis** — Azure Cache for Redis → `REDIS_URL`.
3. **Blob Storage** — create a container, set `AZURE_STORAGE_CONNECTION_STRING`.
   The API *refuses to boot* in production without it, because the dev fallback
   writes to a container's ephemeral disk and would lose every logo on redeploy.
4. **DNS** — a wildcard `*.dinedirect.manvion.ca` CNAME to the web container app, so every new
   restaurant's subdomain works the moment they publish, with no DNS step.
5. **Secrets** — everything in `.env.example` marked required. Store them as Container
   App secrets, not image layers.
6. **Webhooks** — point Stripe at `https://api.dinedirect.manvion.ca/api/payments/webhook` and
   Uber at `https://api.dinedirect.manvion.ca/api/delivery/webhook`.

`NEXT_PUBLIC_*` values are inlined into the browser bundle **at build time** — they
are Docker build args, not runtime env vars. Changing them needs a rebuild.

---

## What's deliberately not built

Honest gaps, not oversights:

- **No address geocoding.** Uber accepts a text address, but latitude/longitude
  would give better quotes and let us enforce `deliveryRadiusMeters`. Wire in a
  geocoder at `StorefrontController.deliveryQuote`.
- **Order polling, not websockets.** The dashboard polls every 10 seconds and the
  tracking page every 15. It's a couple of indexed reads and it's honest; a socket
  layer is real infrastructure to keep alive for a difference no one can perceive.
- **No coupons.** `discountCents` is threaded through the pricing engine and the
  schema, but nothing sets it yet.
- **Refunds are manual.** Cancelling a paid order notifies the customer but does not
  auto-refund — that's a deliberate choice a human should make. The refund endpoint
  is there (`POST /api/payments/orders/:id/refund`, full or partial).
