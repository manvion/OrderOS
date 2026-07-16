-- Countdown target for the public order-status board. Additive-only, safe to apply live.
ALTER TABLE "orders" ADD COLUMN "estimatedReadyAt" TIMESTAMP(3);
