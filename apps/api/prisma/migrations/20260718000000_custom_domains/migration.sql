-- Custom domains: a restaurant serving their storefront at joesburgers.com.
--
-- One row per domain, attached to the single multi-tenant Vercel project. The
-- domain is the natural key and is UNIQUE across the whole platform: two
-- restaurants cannot both claim joesburgers.com, and the resolver (host -> slug)
-- depends on that uniqueness to be unambiguous.

-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING_DNS', 'ISSUING_CERT', 'ACTIVE', 'FAILED');

-- CreateTable
CREATE TABLE "custom_domains" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'PENDING_DNS',
    -- The exact records the owner must paste into their registrar, computed by us
    -- (apex needs an A record, a subdomain needs a CNAME) and stored so the
    -- dashboard can show them without calling Vercel on every page load.
    "dnsRecords" JSONB,
    "error" TEXT,
    "vercelConfigured" BOOLEAN NOT NULL DEFAULT false,
    "sslActive" BOOLEAN NOT NULL DEFAULT false,
    -- Stripe registers Apple Pay PER DOMAIN. Without this, the Apple Pay button
    -- silently never renders on the restaurant's own domain.
    "applePayRegistered" BOOLEAN NOT NULL DEFAULT false,
    "checkAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "custom_domains_domain_key" ON "custom_domains"("domain");

-- CreateIndex
CREATE INDEX "custom_domains_restaurantId_idx" ON "custom_domains"("restaurantId");

-- CreateIndex: the verification cron scans by status.
CREATE INDEX "custom_domains_status_idx" ON "custom_domains"("status");

-- AddForeignKey
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
