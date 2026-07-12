# Deploying OrderOS

Two pieces, deployed differently, because they have different shapes:

| Piece | Where | Why |
| --- | --- | --- |
| `apps/web` (Next.js) | **Vercel** | Edge middleware does the tenant routing, and Vercel is what attaches restaurants' custom domains for us. |
| `apps/api` (NestJS) | **A container host** — Railway, Render, Fly, Azure Container Apps | It runs BullMQ workers, cron jobs and a long-lived Redis connection. None of that survives on serverless: a cron that fires every five minutes needs a process that is still alive in five minutes. |

Plus a Postgres and a Redis. Any managed ones (Neon/Supabase/RDS, Upstash/Elasticache) are fine.

**One deployment serves every restaurant.** There is no repo, no project and no build per
tenant. `joes.orderos.ai`, `marias.orderos.ai` and `joesburgers.com` all hit the same Vercel
deployment; `apps/web/src/middleware.ts` reads the `Host` header and rewrites to `/s/<slug>`.
A repo-per-restaurant design would mean a thousand builds and a security fix that has to be
rolled out a thousand times.

---

## 1. Push to a git repo

```bash
git init
git add -A
git commit -m "OrderOS"
gh repo create orderos --private --source=. --push
```

`.env` is gitignored. Check that it stayed out: `git ls-files | grep -c '^\.env$'` must print `0`.

## 2. Database + Redis

Create a Postgres and a Redis, then run the migrations **once**, from your machine, against
the production database:

```bash
DATABASE_URL="postgres://…prod…" npm run db:deploy
```

That runs `prisma migrate deploy`, which applies the migrations in
`apps/api/prisma/migrations/` and never generates new ones. It is the only migrate command
safe to point at production — `db:migrate` (`migrate dev`) will happily reset the database.

## 3. Deploy the API

Container host of your choice; `apps/api/Dockerfile` is ready. Env vars: everything in
`.env.example` except the `NEXT_PUBLIC_*` block. It must be reachable over HTTPS on a stable
hostname — say `api.orderos.ai` — because the browser and the Vercel middleware both call it.

Set `CORS_ORIGINS` to your dashboard origin (`https://orderos.ai`). Tenant subdomains,
customers' custom domains and registered widget hosts are allowed **dynamically** at runtime
(see `main.ts`), so they do not go in this list.

## 4. Deploy the web app to Vercel

Import the repo at vercel.com/new, then:

- **Root Directory:** `apps/web` — Vercel picks up the npm workspace at the repo root, which
  is what makes `@orderos/shared` resolve. Do not override the install command; overriding it
  runs `npm install` inside `apps/web`, where the workspace root doesn't exist, and the build
  fails on `@orderos/shared`.
- **Environment variables:**

  | Variable | Value |
  | --- | --- |
  | `NEXT_PUBLIC_API_URL` | `https://api.orderos.ai` |
  | `NEXT_PUBLIC_APP_DOMAIN` | `orderos.ai` |
  | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | your Clerk `pk_live_…` |
  | `CLERK_SECRET_KEY` | your Clerk `sk_live_…` |

  `NEXT_PUBLIC_*` values are **inlined into the browser bundle at build time**. Changing one
  needs a redeploy, not a restart.

Deploy. You now have `orderos-xxx.vercel.app`.

## 5. Point your own domain at it

In Vercel → Project → Domains, add `orderos.ai` and `*.orderos.ai`.

The **wildcard is the whole product** — it is what makes `anything.orderos.ai` resolve to a
tenant without us touching DNS every time a restaurant signs up. Vercel gives you the records;
at your registrar you will add roughly:

| Type | Name | Value |
| --- | --- | --- |
| A | `@` | `76.76.21.21` |
| CNAME | `*` | `cname.vercel-dns.com` |
| CNAME | `api` | your API host |

A wildcard CNAME needs a registrar that supports one (Cloudflare, Namecheap, Route53 all do).

## 6. Turn on custom domains for restaurants

This is the "bring your own domain" feature — a restaurant serving their storefront at
`joesburgers.com` instead of `joes.orderos.ai`.

We do **not** sell or register domains. The owner buys theirs wherever they like; we attach it
and tell them exactly which DNS records to paste in. On the API set:

```
VERCEL_TOKEN=…      # scoped to this project, needs domain permissions
VERCEL_PROJECT_ID=… # Vercel → Project → Settings → Project ID
VERCEL_TEAM_ID=…    # only if the project lives under a team — a missing team ID is the
                    # usual cause of a 403 from the Vercel API
```

Then, from the restaurant's side, **Dashboard → Domain**:

1. They type `joesburgers.com` and hit Connect.
2. We attach it to this Vercel project and compute the records they need:
   - an **apex** domain (`joesburgers.com`) gets an **A** record — an apex *cannot* take a
     CNAME. That is a DNS rule, not our choice, and it is the single most common way a custom
     domain silently never resolves.
   - a **subdomain** (`order.joesburgers.com`) gets a **CNAME**.
3. They paste those into their registrar. We poll every five minutes; the page also polls
   while they watch. When DNS lands, Vercel issues the certificate and the domain flips to
   **Live** on its own — they can close the tab.
4. On going live we also register the domain with Stripe for **Apple Pay**. Miss this and the
   Apple Pay button silently never renders on their site, with no error anywhere.

## 7. What to check before you call it live

Not "the build succeeded" — that has lied before. Check content:

```bash
curl -s https://orderos.ai | grep -o "<title>[^<]*"          # the marketing site
curl -s https://joes.orderos.ai | grep -o "<title>[^<]*"     # a tenant, not the marketing site
curl -s https://api.orderos.ai/health                         # {"status":"ok"}
curl -sI https://joes.orderos.ai/widget.js | head -1          # 200, not 404
```

If a tenant subdomain returns the marketing homepage, the middleware isn't running —
it must live at `apps/web/src/middleware.ts` (Next ignores a root-level `middleware.ts`
when a `src/` directory exists).
