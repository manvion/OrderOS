-- The language the customer ordered in, so their texts/emails come back in it.
ALTER TABLE "orders" ADD COLUMN "locale" TEXT;
