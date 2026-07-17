-- The restaurant's own driver can now share live location from their phone via a
-- capability link (/d/<token>), so a self-delivery gets a moving pin on the
-- customer's map like a dispatched courier does. Additive and nullable.
ALTER TABLE "deliveries" ADD COLUMN "driverShareToken" TEXT;

CREATE UNIQUE INDEX "deliveries_driverShareToken_key" ON "deliveries"("driverShareToken");

-- Proof-of-delivery photo taken by the driver at handover.
ALTER TABLE "deliveries" ADD COLUMN "proofOfDeliveryUrl" TEXT;
