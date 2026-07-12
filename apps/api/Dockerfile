# Multi-stage build. The final image carries the compiled JS, the generated
# Prisma client and production deps — no TypeScript, no source, no dev toolchain.

FROM node:22-alpine AS base
# Prisma's query engine needs OpenSSL, which alpine doesn't ship by default.
RUN apk add --no-cache openssl
WORKDIR /app

# --- Dependencies ------------------------------------------------------------
FROM base AS deps

# Copy only the manifests first: this layer is cached and only busts when a
# dependency actually changes, not on every source edit.
COPY package.json package-lock.json* ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --workspaces --include-workspace-root

# --- Build -------------------------------------------------------------------
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY package.json package-lock.json* ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

WORKDIR /app/apps/api
RUN npx prisma generate
RUN npm run build

# Drop dev dependencies before we copy node_modules into the runner.
RUN npm prune --omit=dev

# --- Runner ------------------------------------------------------------------
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Never run as root.
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nestjs

COPY --from=builder --chown=nestjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/package.json ./apps/api/
COPY --from=builder --chown=nestjs:nodejs /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder --chown=nestjs:nodejs /app/packages/shared ./packages/shared

USER nestjs
WORKDIR /app/apps/api

EXPOSE 4000

# Migrations run at startup, not at build time — the database doesn't exist yet
# when the image is built. `migrate deploy` is the non-interactive, production-safe
# variant: it applies pending migrations and never generates or resets anything.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
