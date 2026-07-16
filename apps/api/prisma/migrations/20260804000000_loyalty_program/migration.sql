-- Points-based loyalty program. Additive-only, safe to apply live.
ALTER TABLE "restaurants" ADD COLUMN "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "loyaltyPointsPerDollar" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "customers" ADD COLUMN "loyaltyPoints" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "orders" ADD COLUMN "loyaltyPointsEarned" INTEGER NOT NULL DEFAULT 0;
