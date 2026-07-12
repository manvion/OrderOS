-- Delivery resilience: automatic re-dispatch when a courier falls through, and
-- escalation to a human when automation has honestly run out of options.
--
-- The invariant these columns exist to enforce:
--   AN ORDER THAT HAS BEEN PAID FOR IS NEVER SILENTLY ABANDONED.
-- It is either progressing, being re-dispatched, or in front of a human with an
-- alarm attached. There is no fourth state.

-- How many DIFFERENT couriers we have had to chase for this order. Distinct from
-- attemptCount (which counts failures to reach Uber at all) — this counts couriers
-- who accepted and then vanished.
ALTER TABLE "deliveries" ADD COLUMN "redispatchCount" INTEGER NOT NULL DEFAULT 0;

-- Set when we stopped automating and put this in front of a person. An escalated
-- delivery has NOT failed: it is still live, still owed to a paying customer, and
-- now loudly the restaurant's problem to solve.
ALTER TABLE "deliveries" ADD COLUMN "escalatedAt" TIMESTAMP(3);
ALTER TABLE "deliveries" ADD COLUMN "escalationReason" TEXT;

-- The watchdog sweeps on these every minute, looking for orders that nothing else
-- noticed: no courier assigned long after the food was ready, dispatches stuck
-- PENDING because they fell off the Redis queue, and couriers who accepted and
-- then went silent.
CREATE INDEX "deliveries_status_escalatedAt_updatedAt_idx"
  ON "deliveries"("status", "escalatedAt", "updatedAt");
