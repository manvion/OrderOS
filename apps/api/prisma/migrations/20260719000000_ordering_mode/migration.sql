-- QR-only restaurants: no website, ordering happens entirely through a scanned code.
--
-- Existing restaurants default to WEBSITE, which is what they already have. This
-- migration therefore changes nothing for anyone currently live.

-- CreateEnum
CREATE TYPE "OrderingMode" AS ENUM ('WEBSITE', 'QR_ONLY');

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "orderingMode" "OrderingMode" NOT NULL DEFAULT 'WEBSITE';
