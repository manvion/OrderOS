-- Scope a promotion to specific products -- both the discount and the
-- storefront "on promo" menu tag. Empty array keeps the existing order-wide
-- behaviour.
ALTER TABLE "promotions" ADD COLUMN "productIds" TEXT[] NOT NULL DEFAULT '{}';
