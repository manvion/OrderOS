-- Restaurant name (wordmark) styling: font feel, colour, and case.
ALTER TABLE "Restaurant" ADD COLUMN "nameFont" TEXT NOT NULL DEFAULT 'DISPLAY';
ALTER TABLE "Restaurant" ADD COLUMN "nameColor" TEXT;
ALTER TABLE "Restaurant" ADD COLUMN "nameTransform" TEXT NOT NULL DEFAULT 'NONE';
