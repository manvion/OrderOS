-- Who the restaurant is to a tax authority, as opposed to who it is to a customer.
--
-- A receipt in Canada, India, the UK or Australia is not a valid tax invoice without
-- the supplier's tax number on it. We had nowhere to put that number, so every
-- receipt those restaurants sent was invalid.
--
-- legalName      — the entity that issues the invoice, which is usually not the brand
--                  on the awning ("1187456 Ontario Inc.", not "Bella Burger").
-- taxId          — GSTIN / GST-HST / VAT / ABN, depending on the country.
-- businessNumber — company registration, where it differs from the tax number. Never
--                  printed on a receipt; kept because accountants ask for it.
--
-- All nullable: a restaurant below the registration threshold has no number, and
-- neither does any restaurant that signed up before today.

-- AlterTable
ALTER TABLE "restaurants" ADD COLUMN "legalName" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "taxId" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "businessNumber" TEXT;
