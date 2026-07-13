-- DoorDash Drive, alongside Uber Direct.
--
-- Two changes, and the order matters.

-- 1. A second courier we can dispatch to.
--
-- ALTER TYPE ... ADD VALUE is safe inside Prisma's transaction on PG12+, with one
-- rule: the new value cannot be USED in the same transaction that adds it. Nothing
-- below writes 'DOORDASH', so this is fine.
ALTER TYPE "DeliveryProvider" ADD VALUE 'DOORDASH';

-- 2. The identifier columns stop being Uber's.
--
-- RENAME, not drop-and-add. These columns hold the live identifiers of deliveries
-- that are in the air RIGHT NOW — a courier riding to a customer with a bag of food.
-- Dropping them would leave those deliveries untrackable and uncancellable: the
-- webhook would arrive, match nothing, and the order would sit at CREATED forever
-- while the food was actually delivered. A rename preserves every row, and Postgres
-- carries the unique constraint and indexes across with it.
ALTER TABLE "deliveries" RENAME COLUMN "uberQuoteId" TO "providerQuoteId";
ALTER TABLE "deliveries" RENAME COLUMN "uberDeliveryId" TO "providerDeliveryId";

-- 3. The per-restaurant switch. Off by default: DoorDash Drive needs its own
--    credentials and a signed agreement, so nobody gets silently opted in.
ALTER TABLE "restaurants" ADD COLUMN "doorDashEnabled" BOOLEAN NOT NULL DEFAULT false;
