-- Whether the restaurant's delivery fee is part of the taxable base.
-- Jurisdiction-specific (taxable in Canada, often not in the US), so it's a
-- per-restaurant setting. Defaults to false = the prior behaviour (delivery untaxed).
ALTER TABLE "restaurants" ADD COLUMN "taxDeliveryFee" BOOLEAN NOT NULL DEFAULT false;
