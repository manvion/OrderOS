-- Actual Stripe processing fee, read back from the charge's balance transaction.
-- Deducted from the restaurant's payout (the restaurant is the settlement merchant
-- via on_behalf_of).
ALTER TABLE "payments" ADD COLUMN "stripeFeeCents" INTEGER;

-- Dine-in table orders the customer chose to settle at the counter.
ALTER TABLE "orders" ADD COLUMN "payAtDesk" BOOLEAN NOT NULL DEFAULT false;
