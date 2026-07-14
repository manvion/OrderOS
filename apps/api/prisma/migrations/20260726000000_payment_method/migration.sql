-- How a payment was actually taken. STRIPE is the online-checkout default;
-- CASH/CARD_TERMINAL exist for a staff-entered walk-in or phone order paid in
-- person, where there is no Stripe charge and so no card/webhook data at all.
CREATE TYPE "PaymentMethod" AS ENUM ('STRIPE', 'CASH', 'CARD_TERMINAL');

ALTER TABLE "payments" ADD COLUMN "method" "PaymentMethod" NOT NULL DEFAULT 'STRIPE';
