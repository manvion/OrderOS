-- CreateEnum
CREATE TYPE "ServiceFeeType" AS ENUM ('FIXED', 'PERCENT');

-- AlterTable: a mandatory service charge (its own customer-facing line), configured per restaurant
ALTER TABLE "restaurants"
  ADD COLUMN "serviceChargeType" "ServiceFeeType" NOT NULL DEFAULT 'FIXED',
  ADD COLUMN "serviceChargeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "serviceChargeBps" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "serviceChargeLabel" TEXT NOT NULL DEFAULT 'Service charge';

-- AlterTable: frozen on each order at checkout, with the label it was shown under
ALTER TABLE "orders"
  ADD COLUMN "serviceChargeCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "serviceChargeLabel" TEXT NOT NULL DEFAULT 'Service charge';
