-- A stylable hero tagline (the restaurant's own words, shown under the logo).
ALTER TABLE "restaurants" ADD COLUMN "heroTagline" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "heroTaglineColor" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "heroTaglineFont" TEXT NOT NULL DEFAULT 'SANS';
