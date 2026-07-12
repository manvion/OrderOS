-- Multi-jurisdiction tax: US, Canada, India.
--
-- A single `taxRateBps` cannot express how these countries actually tax restaurant
-- food, and pretending otherwise produces receipts that are illegal in two of the
-- three:
--
--   CANADA  Quebec charges GST 5% + QST 9.975% as SEPARATE, separately-named lines.
--           Ontario charges a single HST 13%. Both must be printed as charged.
--   INDIA   Restaurant GST is 5%, but levied as CGST 2.5% + SGST 2.5%, and a tax
--           invoice must itemise both.
--   US      One line, but the rate depends on state + county + city.
--
-- So tax becomes a LIST of named components. `taxRateBps` survives as their sum,
-- for quick display and for the simple single-rate case.

ALTER TABLE "restaurants" ADD COLUMN "taxComponents" JSONB;
ALTER TABLE "restaurants" ADD COLUMN "taxCountry" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "taxRegion" TEXT;

-- Tax exactly as it was charged and printed: [{ name, rateBps, amountCents }].
--
-- Frozen at checkout. A rate change must never rewrite a receipt that has already
-- been issued, and a tax audit reads THIS column, not today's settings.
ALTER TABLE "orders" ADD COLUMN "taxLines" JSONB;
