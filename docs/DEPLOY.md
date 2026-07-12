# Deploying OrderOS, step by step

Read this once before starting. The order matters: each phase ends in a check that
must pass before you go on, and **Phase 0 is not optional**. Nothing in this codebase
has ever run against a real database, so the first order you place yourself will find
more bugs than any amount of further reading.

Two pieces, deployed differently, because they have different shapes:

| Piece | Where | Why |
| --- | --- | --- |
| `apps/web` (Next.js) | **Vercel** | Edge middleware does the tenant routing, and Vercel is what attaches restaurants' custom domains. |
| `apps/api` (NestJS) | **A container host** — Railway, Render, Fly, Azure Container Apps | It runs BullMQ workers, cron jobs and a long-lived Redis connection. A cron that fires every five minutes needs a process that is still alive in five minutes; serverless is not that. |

Plus a Postgres and a Redis (Neon/Supabase/RDS, Upstash/Elasticache — any managed pair).

**One deployment serves every restaurant.** No repo, no project, no build per tenant.
`joes.orderos.ai`, `marias.orderos.ai` and `joesburgers.com` all hit the same Vercel
deployment; [middleware.ts](../apps/web/src/middleware.ts) reads the `Host` header and
rewrites to `/s/<slug>`. A repo-per-restaurant design means a thousand builds and a
security fix rolled out a thousand times.

---

## Phase 0 — Prove it works on your machine (do this first)

You need Docker. Everything else is in the repo.

```bash
cp .env.example .env          # then fill in the keys below
npm install
npm run infra:up              # Postgres + Redis in Docker
npm run db:deploy             # apply all migrations
npm run db:seed               # a demo restaurant with a real menu
npm run dev                   # API on :4000, web on :3000
```

The API **refuses to boot** without these four — deliberately, because a missing
Stripe secret should crash at startup, not at 7pm on a Friday when someone tries to
pay. Everything else in `.env.example` is optional and no-ops loudly when absent.

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | `postgresql://orderos:orderos@localhost:5432/orderos` (the compose file) |
| `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` | Clerk dashboard → API keys. Use the **test** keys. |
| `STRIPE_SECRET_KEY` | Stripe dashboard → test mode → `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | `stripe listen --forward-to localhost:4000/api/payments/webhook` prints a `whsec_…` |

Then check it:

```bash
npm run smoke
```

That asserts on **content**, not status codes — it verifies the seeded restaurant
resolves, its menu is priced, an unknown slug 404s instead of leaking a default
tenant, and the dashboard rejects an unauthenticated caller.

**Then do the thing the script can't.** Open http://localhost:3000/s/bellaburger,
add something to the cart, check out, and pay with Stripe's test card
`4242 4242 4242 4242`. Watch the order move to PAID. Until you have seen that happen
once, you do not know that this works, and neither do I.

## Phase 1 — Database and Redis in production

Create a managed Postgres and Redis. Then apply the migrations **from your machine**,
once:

```bash
DATABASE_URL="postgres://…prod…" npm run db:deploy
```

`db:deploy` runs `prisma migrate deploy`: it applies what's in
`apps/api/prisma/migrations/` and never generates anything new. It is the only migrate
command safe to point at production — `db:migrate` (`migrate dev`) will happily reset
the database.

Do **not** seed production.

## Phase 2 — Deploy the API

Container host of your choice; [apps/api/Dockerfile](../apps/api/Dockerfile) is ready.

Set every variable from `.env.example` **except** the `NEXT_PUBLIC_*` block (those
belong to the web app). Live keys this time, and:

- `NODE_ENV=production`
- `APP_DOMAIN=orderos.ai`
- `WEB_URL=https://orderos.ai`
- `CORS_ORIGINS=https://orderos.ai` — just your dashboard. Tenant subdomains, custom
  domains and registered widget hosts are allowed **dynamically** at runtime (see
  [main.ts](../apps/api/src/main.ts)), so they do not go in this list.

It must be reachable over HTTPS on a stable hostname — say `api.orderos.ai` — because
the browser and the Vercel middleware both call it.

Check: `curl https://api.orderos.ai/health` returns `{"status":"ok"}`, and
`/health/ready` also returns ok (that one proves it reached Postgres and Redis; a
green deploy with an unreachable database is the classic first failure).

## Phase 3 — Deploy the web app to Vercel

```bash
git init && git add -A && git commit -m "OrderOS"
gh repo create orderos --private --source=. --push
```

`.env` is gitignored. Confirm: `git ls-files | grep -c '^\.env$'` must print `0`.

Import the repo at vercel.com/new, then:

- **Root Directory:** `apps/web`. Vercel picks up the npm workspace at the repo root,
  which is what makes `@orderos/shared` resolve. **Do not override the install
  command** — overriding it runs `npm install` inside `apps/web`, where the workspace
  root doesn't exist, and the build dies on `@orderos/shared`.
- **Environment variables:**

  | Variable | Value |
  | --- | --- |
  | `NEXT_PUBLIC_API_URL` | `https://api.orderos.ai` |
  | `NEXT_PUBLIC_APP_DOMAIN` | `orderos.ai` |
  | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_…` |
  | `CLERK_SECRET_KEY` | `sk_live_…` |

  `NEXT_PUBLIC_*` are **inlined into the browser bundle at build time**. Changing one
  needs a redeploy, not a restart.

## Phase 4 — Point your domain at it

In Vercel → Project → Domains, add `orderos.ai` **and `*.orderos.ai`**.

The wildcard is the whole product: it is what makes `anything.orderos.ai` resolve to a
tenant without you touching DNS every time a restaurant signs up. At your registrar:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `76.76.21.21` |
| CNAME | `*` | `cname.vercel-dns.com` |
| CNAME | `api` | your API host |

A wildcard CNAME needs a registrar that supports one (Cloudflare, Namecheap, Route53
all do).

## Phase 5 — Webhooks

Two, and both fail **silently** if you skip them — orders will sit unpaid forever and
deliveries will never update.

- **Stripe** → Developers → Webhooks → `https://api.orderos.ai/api/payments/webhook`.
  Events: `checkout.session.completed`, `checkout.session.expired`,
  `payment_intent.payment_failed`, `charge.refunded`. Copy the signing secret into
  `STRIPE_WEBHOOK_SECRET` and **redeploy the API** — it is read at boot.
- **Uber Direct** (only if you're doing delivery) → set the webhook URL to
  `https://api.orderos.ai/api/delivery/webhook` and put the shared secret in
  `UBER_WEBHOOK_SECRET`.

Check: place a live order with a real card for £1, and watch it reach PAID. Refund
yourself afterwards.

## Phase 6 — Make yourself a platform admin

There is no UI for this and no "first user becomes admin" rule, on purpose: platform
admins live in their own table, and no role a restaurant can hold grants it. The
console that sees every restaurant's revenue and can suspend any of them must not be
reachable by escalating a role inside the product.

1. Sign up at `https://orderos.ai/sign-up` like anyone else.
2. Find your Clerk user id (Clerk dashboard → Users → you → "User ID", `user_2…`).
3. From your machine, pointed at production:

```bash
DATABASE_URL="postgres://…prod…" npm run admin:create -- \
  --email you@orderos.ai --clerk-id user_2abc... --role SUPER_ADMIN
```

Now `https://orderos.ai/admin` works. From there you can onboard a restaurant and set
up everything for them — menu, branding, hours, QR codes, Stripe, widget, domain.

## Phase 7 — Before you send a real customer

```bash
API_URL=https://api.orderos.ai WEB_URL=https://orderos.ai npm run smoke
```

Then, by hand, once:

- A real order, paid with a real card, that reaches PAID and prints in the kitchen.
- The SMS and the email actually arrive.
- If you use delivery: a courier is actually dispatched.

---

## Known gaps — read before going live

Being straight with you about what has and hasn't been proven:

- **No integration tests.** The 78 passing tests cover pricing, tax, geocoding, DNS
  records, notification templates and widget security — the pure logic. Every module
  that touches the database or a third party (orders, payments, delivery, menu,
  admin, storefront, widget, QR) has none. Phase 0 is how you compensate.
- **No CI.** Nothing stops a broken commit from deploying.
- **No error tracking or metrics.** Add Sentry before your first incident, not after.
- **Never load-tested.** The design scales (stateless API, queue-backed workers, one
  multi-tenant deployment), but nobody has found where it breaks.
- **US sales tax is state-base only.** Real rates are state + county + city across
  ~11,000 jurisdictions. The signup wizard says so and makes the restaurant confirm.
  Do not quietly present it as authoritative.
- **Multi-location is not built.**

## If a tenant subdomain shows the marketing homepage

The middleware isn't running. It must live at `apps/web/src/middleware.ts` — Next
ignores a root-level `middleware.ts` when a `src/` directory exists, and it does so
without a warning, while the build still says it succeeded.
