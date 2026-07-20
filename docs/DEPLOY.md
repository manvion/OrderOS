# Deploying DineDirect — the detailed version

Follow this in order. Each phase ends in a check that must pass before you move on;
if a check fails, fix it there rather than carrying the problem forward.

Budget roughly: 1–2 hours for Phase 0, another 2–3 hours for the rest.

## The shape of the system

| Piece | Where it runs | Why there |
| --- | --- | --- |
| `apps/web` (Next.js) | **Vercel** | Edge middleware does the tenant routing, and Vercel's API is what attaches restaurants' custom domains. |
| `apps/api` (NestJS) | **A container host** — Railway, Render, Fly, Azure Container Apps | It runs BullMQ workers and cron jobs. A cron that fires every five minutes needs a process that is still alive in five minutes; serverless is not that. |
| Postgres | Neon / Supabase / RDS | Everything that must survive. Including the delivery retry queue — see below. |
| Redis | Upstash / Elasticache | The dispatch lock, rate limiting, and caches. **No durable state.** |

Redis holds nothing you cannot afford to lose. The delivery retry queue used to live
in a Redis sorted set, which meant an eviction or a restart silently forgot that an
order still needed a courier — a failure whose first symptom is a customer phoning
about food that never came. It is a Postgres column now (`deliveries.nextRetryAt`),
written in the same statement that records the failure. Losing Redis costs you a slow
minute and nothing else.

Redis is still **required**: it holds the lock that stops two API instances
dispatching two couriers for one order, and it backs the rate limiter.

**One deployment serves every restaurant.** `joes.dinedirect.manvion.ca`, `marias.dinedirect.manvion.ca` and
`joesburgers.com` all hit the same Vercel deployment;
[middleware.ts](../apps/web/src/middleware.ts) reads the `Host` header and rewrites to
`/s/<slug>`. There is no repo, project or build per tenant.

---

# Phase 0 — Get it running locally, and place a real order

**Do not skip this.** No part of this codebase has ever run against a real database.
The first order you place yourself will find more bugs than any amount of reading.

## 0.1 Prerequisites

- Node 20+ (`node -v`)
- Docker Desktop, running
- A Stripe account (test mode) and a Clerk account. Both free.

## 0.2 Accounts and keys

**Clerk** (auth for restaurant staff — customers never need it):

1. clerk.com → create an application. Enable Email + Google.
2. **API keys** → copy the two **test** keys: `pk_test_…` and `sk_test_…`.

**Stripe** (payments, and Connect for paying restaurants out):

1. dashboard.stripe.com, toggle **Test mode** on (top right).
2. **Developers → API keys** → copy the secret key `sk_test_…`.
3. **Connect → Get started** → enable it, pick **Platform or marketplace**.
   This matters: the API creates an **Express** connected account per restaurant
   ([payments.service.ts](../apps/api/src/modules/payments/payments.service.ts#L50)),
   so money flows customer → restaurant's own Stripe, with our fee taken on top. We
   never hold their money. Without Connect enabled, restaurant onboarding fails.

## 0.3 Configure and start

```bash
cp .env.example .env
```

Edit `.env`. These four are **mandatory** — the API refuses to boot without them, on
purpose, because a missing Stripe secret should crash at startup and not at 7pm on a
Friday when a customer tries to pay:

```ini
DATABASE_URL=postgresql://dinedirect:dinedirect@localhost:5432/dinedirect
CLERK_SECRET_KEY=sk_test_...
CLERK_PUBLISHABLE_KEY=pk_test_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=            # filled in at 0.5
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...   # same value as CLERK_PUBLISHABLE_KEY
```

Everything else is optional and no-ops loudly when absent: Twilio (SMS), Resend
(email), Uber Direct (delivery), Azure Blob (image uploads fall back to local disk).

```bash
npm install
npm run infra:up      # Postgres + Redis in Docker
npm run db:deploy     # applies all 9 migrations — the first time they have ever run
npm run db:seed       # one restaurant, "bellaburger", with a real menu
npm run dev           # API on :4000, web on :3000
```

**If `db:deploy` fails**, stop. That is the migrations meeting a real Postgres for the
first time, and it is exactly the thing this phase exists to find.

## 0.4 First checks

```bash
npm run smoke
```

It asserts on **content**, not status codes — it verifies the seeded restaurant
resolves, its menu is priced, an unknown slug 404s rather than leaking a default
tenant, and the dashboard rejects an unauthenticated caller.

Then open http://localhost:3000/s/bellaburger. (Use the `/s/<slug>` form: Windows
cannot resolve `*.localhost` at all, whatever the Chrome address bar suggests.)

## 0.5 Stripe webhooks locally

In a second terminal:

```bash
stripe login
stripe listen --forward-to localhost:4000/api/payments/webhook
```

It prints `whsec_…`. Put that in `.env` as `STRIPE_WEBHOOK_SECRET` and **restart the
API** — it is read at boot, not per request.

## 0.6 The one test that matters

1. Sign up at http://localhost:3000/sign-up. The first account to create a restaurant
   becomes its OWNER.
2. Dashboard → **Get set up**. Work the checklist: menu, fulfillment, Stripe.
3. Connect Stripe. You'll be sent through Express onboarding — in test mode you can
   fill it with anything.
4. **Go live.**
5. Open the storefront, add a burger, check out, pay with `4242 4242 4242 4242`
   (any future expiry, any CVC).
6. Watch the order appear in Dashboard → Orders as **PAID**.

If step 6 works, the system is real. If it doesn't, nothing after this matters yet.

---

# Phase 1 — Production database and Redis

1. **Postgres**: neon.tech → new project → copy the connection string. Make sure it
   ends in `?sslmode=require`.
2. **Redis**: upstash.com → new database → copy the `rediss://` URL.
3. Apply the migrations **once**, from your machine:

```bash
DATABASE_URL="postgres://…prod…?sslmode=require" npm run db:deploy
```

`db:deploy` is `prisma migrate deploy`: it applies what is in
`apps/api/prisma/migrations/` and generates nothing. It is the only migrate command
safe to point at production — `db:migrate` (`migrate dev`) will happily **reset the
database**.

**Do not seed production.**

Check: `npx prisma studio` against the production URL shows empty tables, not an error.

---

# Phase 2 — Deploy the API

Any container host. Railway is the shortest path:

1. railway.app → **New Project → Deploy from GitHub repo** (push the repo first — see
   3.1 below if you haven't).
2. Settings → **Root Directory**: leave as the repo root.
   **Dockerfile Path**: `apps/api/Dockerfile`.
3. Variables — everything from `.env.example` **except** the `NEXT_PUBLIC_*` block,
   with **live** keys this time:

```ini
NODE_ENV=production
PORT=4000
DATABASE_URL=postgres://…neon…
REDIS_URL=rediss://…upstash…

APP_DOMAIN=dinedirect.manvion.ca
API_URL=https://api.dinedirect.manvion.ca
WEB_URL=https://dinedirect.manvion.ca
CORS_ORIGINS=https://dinedirect.manvion.ca

CLERK_SECRET_KEY=sk_live_...
CLERK_PUBLISHABLE_KEY=pk_live_...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=            # filled in at Phase 5
PLATFORM_FEE_BPS=300              # 3% — your commission. Per-restaurant overrides live in the admin console.
```

`CORS_ORIGINS` is **just your dashboard**. Tenant subdomains, restaurants' custom
domains and registered widget hosts are allowed **dynamically at runtime** by
[main.ts](../apps/api/src/main.ts) — putting them here would be both wrong and
impossible (you don't know them at boot).

4. Add a custom domain: `api.dinedirect.manvion.ca`.

**Check:**

```bash
curl https://api.dinedirect.manvion.ca/health         # {"status":"ok"}
curl https://api.dinedirect.manvion.ca/health/ready   # {"status":"ok"} -- this one proves it reached Postgres AND Redis
```

`/health/ready` is the important one. A green deploy with an unreachable database is
the classic first production failure, and `/health` alone will happily lie about it.

---

# Phase 3 — Deploy the web app to Vercel

## 3.1 Push the repo

```bash
git add -A && git commit -m "DineDirect"
gh repo create dinedirect --private --source=. --push
```

`.env` is gitignored. Confirm before pushing: `git ls-files | grep -c '^\.env$'` must
print `0`.

## 3.2 Import into Vercel

vercel.com/new → import the repo, then:

- **Root Directory: `apps/web`.** Vercel detects the npm workspace at the repo root,
  which is what makes `@dinedirect/shared` resolve.
- **Do NOT override the Install Command.** Overriding it runs `npm install` inside
  `apps/web`, where the workspace root does not exist, and the build dies on
  `@dinedirect/shared`. This is the single most common way this deploy fails.
- Environment variables:

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://api.dinedirect.manvion.ca` |
| `NEXT_PUBLIC_APP_DOMAIN` | `dinedirect.manvion.ca` |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_…` |
| `NEXT_PUBLIC_MAPTILER_KEY` | `…` (optional — Google/Uber-grade delivery-map tiles) |
| `CLERK_SECRET_KEY` | `sk_live_…` |

`NEXT_PUBLIC_*` values are **inlined into the browser bundle at build time**. Changing
one requires a redeploy, not a restart. On Vercel that happens automatically. **On a
Docker deploy** (Fly/Render/self-hosted) a `NEXT_PUBLIC_*` set only as a runtime secret
does nothing — it must be passed as a `--build-arg` to `docker build` (see the `args:`
block in `docker-compose.yml`). `NEXT_PUBLIC_MAPTILER_KEY` is the one that bites people:
set it at runtime and the delivery map still shows the paler free CARTO tiles, because
the key was never in the build.

Deploy. You now have `dinedirect-xxx.vercel.app`.

---

# Phase 4 — DNS

In Vercel → Project → Domains, add **both**:

- `dinedirect.manvion.ca`
- `*.dinedirect.manvion.ca`  ← the wildcard

The wildcard is the whole product. It is what makes `anything.dinedirect.manvion.ca` resolve to a
tenant without you touching DNS every time a restaurant signs up.

At your registrar:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `76.76.21.21` |
| CNAME | `*` | `cname.vercel-dns.com` |
| CNAME | `api` | your Railway/Render hostname |

A wildcard CNAME needs a registrar that supports one (Cloudflare, Namecheap, Route53
all do). If you use Cloudflare, set the wildcard record to **DNS only** (grey cloud),
not proxied — proxying it breaks Vercel's certificate issuance.

**Check:** `curl -s https://dinedirect.manvion.ca | grep -o '<title>[^<]*'` returns your marketing
page, and a published restaurant's subdomain returns *their* page, not the marketing
one. If a tenant subdomain shows the marketing homepage, the middleware isn't running —
see Troubleshooting.

## Clerk production instance

Clerk needs to know its production domain: Clerk dashboard → your app → **Domains** →
add `dinedirect.manvion.ca`, and add the DNS records Clerk gives you (a few CNAMEs on
`clerk.`, `accounts.`, etc). Until that is done, sign-in will fail in production even
though it worked locally.

---

# Phase 5 — Webhooks

Both of these fail **silently** if you skip them. Orders will sit unpaid forever and
nothing anywhere will say why.

## Stripe

dashboard.stripe.com → **Developers → Webhooks → Add endpoint**

- URL: `https://api.dinedirect.manvion.ca/api/payments/webhook`
- Events — all five:
  - `checkout.session.completed` — the order is paid. Without this, **no order ever
    reaches PAID.**
  - `checkout.session.expired`
  - `payment_intent.payment_failed`
  - `charge.refunded`
  - **`account.updated`** — a restaurant finished Stripe Connect onboarding. Without
    this, `stripeChargesEnabled` never flips true, the setup checklist keeps saying
    "connect Stripe" forever, and **no restaurant can ever publish.**

Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and **redeploy the API** (read at
boot).

**Check:** Stripe → Webhooks → your endpoint → **Send test webhook** →
`checkout.session.completed`. It must return 200. A 400 means the signature check
failed — almost always the wrong `whsec_`, or the API not restarted after setting it.

## Uber Direct (only if you offer delivery)

Set the webhook URL to `https://api.dinedirect.manvion.ca/api/delivery/webhook` and put the shared
secret in `UBER_WEBHOOK_SECRET`, along with `UBER_CLIENT_ID`, `UBER_CLIENT_SECRET`,
`UBER_CUSTOMER_ID`. Without these, delivery is simply disabled — the app runs fine on
pickup and dine-in.

## Optional but wanted before real customers

| What | Variables | Without it |
| --- | --- | --- |
| SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | No order-status texts. Sends become no-ops and log. |
| Email | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | No receipts, **and no staff invitations** — which means you cannot onboard a restaurant owner. |
| Image uploads | `S3_*` (Cloudflare R2) **or** `AZURE_STORAGE_CONNECTION_STRING` | **The API refuses to boot in production without one.** See below. |
| Delivery radius | `GOOGLE_MAPS_API_KEY` or `MAPBOX_TOKEN` | Falls back to Nominatim, which is rate-limited and not acceptable for production traffic. |
| Custom domains | `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | The "bring your own domain" feature is disabled and says so. |

Note the email one: **without Resend, invitations don't send**, and the whole
onboarding flow depends on the owner receiving one.

## Object storage — Cloudflare R2 (5 minutes)

The API **refuses to boot in production** without object storage, on purpose. Without
it, uploads go to the container's disk, which works perfectly right up until the
redeploy that silently erases every image every restaurant has ever uploaded.

R2 is the easy option: free to 10GB, no egress fees.

1. Cloudflare → **R2** → **Create bucket**, name it `dinedirect-media`.
2. **Manage R2 API Tokens** → **Create API token** → *Object Read & Write* → copy the
   **Access Key ID** and **Secret Access Key**, and note the **endpoint**
   (`https://<account-id>.r2.cloudflarestorage.com`).
3. Bucket → **Settings** → **Public access** → enable the **r2.dev subdomain**. Copy
   that URL (`https://pub-<hash>.r2.dev`).
4. On the API:

```ini
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com   # where we UPLOAD
S3_BUCKET=dinedirect-media
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_REGION=auto
S3_PUBLIC_URL=https://pub-<hash>.r2.dev                     # where the world READS
```

**`S3_ENDPOINT` and `S3_PUBLIC_URL` are different URLs.** That is the one thing people
get wrong: uploads succeed, and every image 403s. The boot check refuses to start
without `S3_PUBLIC_URL` for exactly this reason.

Any S3-compatible store works — AWS S3, Backblaze B2, MinIO, DigitalOcean Spaces — or
use `AZURE_STORAGE_CONNECTION_STRING` if you already live in Azure.

Check: upload a logo in the dashboard, then hard-refresh the storefront. If the image
renders, storage is correct. If it downloads instead of displaying, the content type
is wrong; if it 403s, `S3_PUBLIC_URL` is wrong.

---

# Phase 6 — Make yourself a platform admin

There is no UI for this and no "first user becomes admin" rule, deliberately: platform
admins live in their own table, and no role a restaurant can hold grants it. The
console that sees every restaurant's revenue and can suspend any of them must not be
reachable by escalating a role inside the product.

1. Sign up at `https://dinedirect.manvion.ca/sign-up` like anybody else.
2. Clerk dashboard → **Users** → you → copy the **User ID** (`user_2…`).
3. From your machine, pointed at production:

```bash
DATABASE_URL="postgres://…prod…" npm run admin:create -- \
  --email you@dinedirect.manvion.ca --clerk-id user_2abc... --role SUPER_ADMIN
```

**Check:** `https://dinedirect.manvion.ca/admin` loads the console. If it says "Not found", the
row didn't take, or you're signed in as a different Clerk user.

---

# Phase 7 — Onboard your first restaurant

From `/admin` → **Onboard a restaurant**. It asks everything: name, subdomain, address,
timezone, hours, fulfillment, tax jurisdiction, ordering mode (website or QR-only), and
your commission. It creates the restaurant and **emails the owner an invitation** — we
never set their password, so we can never silently log in as them.

Then either they finish setup, or you do it for them: each row in the console has a
**Set up** panel (menu, branding, hours, QR codes, Stripe, widget, domain) that opens
their dashboard through a time-boxed support session — one hour, a written reason, and
it lands on their audit log.

The console shows exactly what each restaurant is still missing ("2/3 — needs: Connect
Stripe"), so a stuck signup is a phone call you can make rather than a number on a
chart.

---

# Phase 8 — Before you send a real customer

```bash
API_URL=https://api.dinedirect.manvion.ca WEB_URL=https://dinedirect.manvion.ca npm run smoke
```

Then, by hand, once, on production:

- A real order paid with a real card, that reaches PAID.
- The SMS and the email actually arrive.
- If you offer delivery: a courier is actually dispatched.
- Refund yourself afterwards.

---

# Troubleshooting

**A tenant subdomain shows the marketing homepage.**
The middleware isn't running. It must live at `apps/web/src/middleware.ts` — Next
ignores a root-level `middleware.ts` when a `src/` directory exists, silently, while
the build still reports success.

**Vercel build fails on `@dinedirect/shared`.**
You overrode the Install Command. Remove the override; Root Directory `apps/web` plus
Vercel's own workspace detection is what makes it resolve.

**Stripe webhook returns 400.**
Signature verification failed. Either `STRIPE_WEBHOOK_SECRET` is from a different
endpoint, or the API wasn't restarted after you set it. The raw body is verified before
parsing, so a proxy that rewrites the body will also break this.

**Restaurants can never publish; the checklist always says "connect Stripe".**
You didn't subscribe to `account.updated`. Nothing else sets `stripeChargesEnabled`.

**Custom domain never goes live.**
An apex domain (`joesburgers.com`) needs an **A** record and cannot take a CNAME. The
dashboard computes the right record; if someone pasted a CNAME on an apex, DNS will
never resolve and nothing will report an error.

---

# Known gaps — read before going live

- **No integration tests.** The 94 passing tests cover pricing, tax, geocoding, DNS
  records, the setup checklist, notification templates and widget security — the pure
  logic. Orders, payments, delivery, menu, admin, storefront, QR have **none**. Phase 0
  is how you compensate.
- **No CI.** Nothing stops a broken commit from deploying.
- **No error tracking or metrics.** Add Sentry before your first incident.
- **Never load-tested.** The design scales; nobody has found where it breaks.
- **US sales tax is state-base only.** Real rates are state + county + city across
  ~11,000 jurisdictions. The wizard says so and makes the restaurant confirm. Do not
  present it as authoritative.
- **Multi-location is not built.**
