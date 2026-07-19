-- Bilingual menu content: French translations of item + category names/descriptions,
-- auto-filled by AI for a BOTH-language storefront. Null falls back to the default.
ALTER TABLE "categories" ADD COLUMN "nameFr" TEXT;
ALTER TABLE "products" ADD COLUMN "nameFr" TEXT;
ALTER TABLE "products" ADD COLUMN "descriptionFr" TEXT;
