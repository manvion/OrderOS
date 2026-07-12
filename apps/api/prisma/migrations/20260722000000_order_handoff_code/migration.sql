-- A handoff code on EVERY order, not just deliveries.
--
-- Pickup customers and dine-in tables had nothing but a sequential order number,
-- which is exactly how a bag goes to the wrong person: 0712-014 and 0712-041 look
-- identical at a glance on a label, read out across a loud counter.
--
-- Nullable, because orders placed before this migration have no code and inventing
-- one retrospectively would print a code on a screen that is not on the bag.

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "handoffCode" TEXT;
