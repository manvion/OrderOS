-- AlterEnum: a payment can now be partly collected
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIALLY_PAID';

-- AlterTable: running balance collected so far toward amountCents
ALTER TABLE "payments" ADD COLUMN "amountPaidCents" INTEGER NOT NULL DEFAULT 0;
