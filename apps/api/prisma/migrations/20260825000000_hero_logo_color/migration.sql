-- A separate colour for the HERO logo (over media), independent of the header logo.
ALTER TABLE "restaurants" ADD COLUMN "heroLogoColor" TEXT NOT NULL DEFAULT 'ORIGINAL';
