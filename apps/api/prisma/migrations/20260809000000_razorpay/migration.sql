-- Razorpay Route support, for restaurants in countries Stripe Connect can't pay
-- out to (India). Additive: existing restaurants (all on Stripe) are untouched.

-- AlterTable
ALTER TABLE "restaurants"
  ADD COLUMN "razorpayAccountId" TEXT,
  ADD COLUMN "razorpayEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payments"
  ADD COLUMN "razorpayOrderId" TEXT,
  ADD COLUMN "razorpayPaymentId" TEXT;

CREATE UNIQUE INDEX "payments_razorpayOrderId_key" ON "payments"("razorpayOrderId");
CREATE UNIQUE INDEX "payments_razorpayPaymentId_key" ON "payments"("razorpayPaymentId");
