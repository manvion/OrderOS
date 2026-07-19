-- Restaurant name (wordmark) styling: font feel, colour, and case.
ALTER TABLE "restaurants" ADD COLUMN "nameFont" TEXT NOT NULL DEFAULT 'DISPLAY';
ALTER TABLE "restaurants" ADD COLUMN "nameColor" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "nameTransform" TEXT NOT NULL DEFAULT 'NONE';
