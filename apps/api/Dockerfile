# Multi-stage build for the NestJS API inside an npm-workspaces monorepo.
#
# Four things here are easy to get wrong, and each one fails only in the container,
# never on a developer's machine. They are called out where they happen.

FROM node:22-alpine AS base
# Prisma's query engine needs OpenSSL, which alpine doesn't ship by default.
RUN apk add --no-cache openssl
WORKDIR /app

# --- Dependencies ------------------------------------------------------------
FROM base AS deps

# Manifests first: this layer is cached and only busts when a dependency actually
# changes, not on every source edit.
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --workspaces --include-workspace-root

# --- Build -------------------------------------------------------------------
FROM base AS builder
WORKDIR /app

# (1) npm workspaces HOIST dependencies to the root node_modules. `apps/api/node_modules`
#     usually does not exist at all — so `COPY --from=deps /app/apps/api/node_modules`
#     fails the build with "not found". Copy the root tree, which is where everything
#     actually is.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

WORKDIR /app/apps/api
RUN npx prisma generate

# (2) The API imports `@orderos/shared` via a tsconfig path alias. `nest build` leaves
#     `require("@orderos/shared")` in the emitted JavaScript, which Node then resolves
#     through packages/shared/package.json — whose `exports` points at src/index.ts, a
#     TypeScript file Node cannot require. The build script runs `tsc-alias`, which
#     rewrites those aliases to relative paths into the compiled output, so the runtime
#     never touches the package entry point. Locally this never breaks, because
#     `nest start` runs through ts-node.
RUN npm run build

# --- Runner ------------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Never run as root.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nestjs

# (3) node_modules is copied WITHOUT pruning dev dependencies, on purpose. The container
#     runs `prisma migrate deploy` at startup, and the `prisma` CLI is a devDependency —
#     prune it and the container tries to download Prisma from npm on every cold start,
#     which is slow, needs network at boot, and fails the deploy when npm has a bad day.
COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/package.json ./
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/package.json ./apps/api/
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=nestjs:nodejs /app/packages/shared ./packages/shared

USER nestjs
WORKDIR /app/apps/api

EXPOSE 4000

# (4) The entrypoint is dist/apps/api/src/main.js, NOT dist/main.js.
#     tsc's outDir mirrors the ROOT of all compiled inputs — and `packages/shared` is one
#     of them, so the common root is the repo, and everything gains an apps/api/src prefix.
#     `node dist/main.js` fails with "Cannot find module", which reads like a broken build
#     rather than a wrong path.
#
# Migrations run at startup rather than at build time, because the database does not exist
# when the image is built. `migrate deploy` is the production-safe variant: it applies
# pending migrations and never generates, resets or prompts.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/apps/api/src/main.js"]
