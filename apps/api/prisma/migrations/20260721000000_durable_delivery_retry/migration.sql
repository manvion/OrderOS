-- Make the delivery retry queue DURABLE.
--
-- It used to be a Redis sorted set. That meant the only record that an order still
-- needed a courier lived in a cache: a Redis eviction, restart or flush silently
-- forgot it, the order sat there with no courier, and nothing anywhere would ever
-- wake it up. The first anyone knew was a customer phoning about food that never
-- came.
--
-- A queue whose loss is invisible is not a queue. It now lives here, on the row it
-- belongs to, written in the same statement that records the failure.
--
-- Redis keeps the dispatch LOCK and the caches. Losing it now costs a slow minute
-- and nothing else.

-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN "nextRetryAt" TIMESTAMP(3);

-- CreateIndex: the drain runs every 30 seconds asking "what is due?". Without this
-- index that question is a full scan of every delivery ever made, twice a minute.
CREATE INDEX "deliveries_nextRetryAt_idx" ON "deliveries"("nextRetryAt");
