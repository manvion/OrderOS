-- Let restaurants make their header logo bigger — a wide "logo + name" wordmark was
-- capped small. Percentage of the default size; 100 = unchanged. Additive.
ALTER TABLE "restaurants" ADD COLUMN "logoScale" INTEGER NOT NULL DEFAULT 100;

-- Optional soft brand-coloured backdrop behind the header logo.
ALTER TABLE "restaurants" ADD COLUMN "logoBackdrop" BOOLEAN NOT NULL DEFAULT false;
