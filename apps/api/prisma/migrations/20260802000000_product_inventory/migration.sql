-- Per-product stock tracking, opt-in. Additive-only, safe to apply live.
ALTER TABLE "products" ADD COLUMN "trackInventory" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "products" ADD COLUMN "stockQuantity" INTEGER NOT NULL DEFAULT 0;
