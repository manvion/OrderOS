-- The courier's quoted cost for this order, recouped from the restaurant inside
-- the same Stripe charge (folded into the application fee). NULL = no courier:
-- pickup, dine-in, self-delivery, or a quote that couldn't be had (platform
-- absorbs that dispatch rather than blocking a paying customer).
ALTER TABLE "payments" ADD COLUMN "courierCostCents" INTEGER;
