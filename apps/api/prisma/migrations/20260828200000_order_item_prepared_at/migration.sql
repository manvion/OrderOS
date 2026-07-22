-- AlterTable: per-item kitchen state, so a round added to an already-served tab cooks
-- on its own while the earlier items stay done.
ALTER TABLE "order_items" ADD COLUMN "preparedAt" TIMESTAMP(3);
