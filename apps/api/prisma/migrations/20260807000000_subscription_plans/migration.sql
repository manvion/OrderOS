-- The SaaS subscription layer.
--
-- DineDirect was a pure marketplace: it made money only by taking a commission
-- (an application fee) on each order. This adds a second, primary revenue line --
-- a per-restaurant SOFTWARE subscription, billed monthly or annually on the
-- platform's own Stripe account -- while KEEPING the commission, now driven by
-- which plan the restaurant is on. Every restaurant that already exists lands on
-- the free STARTER tier, ACTIVE, which is exactly where a new signup starts too,
-- so nothing about their current access changes on deploy.

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED');

-- AlterTable
ALTER TABLE "restaurants"
  ADD COLUMN "commissionOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "planTier" "PlanTier" NOT NULL DEFAULT 'STARTER',
  ADD COLUMN "subscriptionStatus" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "billingInterval" "BillingInterval",
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "stripeSubscriptionId" TEXT,
  ADD COLUMN "planCurrentPeriodEnd" TIMESTAMP(3);

-- A restaurant is found from its Stripe subscription in the billing webhook, so
-- that lookup must be indexed and one-to-one.
CREATE UNIQUE INDEX "restaurants_stripeSubscriptionId_key" ON "restaurants"("stripeSubscriptionId");
CREATE UNIQUE INDEX "restaurants_stripeCustomerId_key" ON "restaurants"("stripeCustomerId");
