-- Courier handoff identification, self-delivery (own driver), and customer accounts.

-- CreateEnum: who actually carries the food, decided PER ORDER.
CREATE TYPE "DeliveryProvider" AS ENUM ('UBER', 'SELF');

-- AlterTable: the restaurant has their own driver. If BOTH this and
-- uberDirectEnabled are on, the dashboard asks per order rather than guessing.
ALTER TABLE "restaurants" ADD COLUMN "selfDeliveryEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: delivery provider + own-driver details + handoff identification.
--
-- pickupCode is the fix for the most expensive routine mistake in delivery:
-- handing the wrong bag to the wrong courier when three bags are on the pass and
-- two drivers are at the counter. It is printed on the bag AND sent to Uber as the
-- manifest reference, so the driver can read it back.
ALTER TABLE "deliveries" ADD COLUMN "provider" "DeliveryProvider" NOT NULL DEFAULT 'UBER';
ALTER TABLE "deliveries" ADD COLUMN "driverName" TEXT;
ALTER TABLE "deliveries" ADD COLUMN "driverPhone" TEXT;
ALTER TABLE "deliveries" ADD COLUMN "pickupCode" TEXT;
ALTER TABLE "deliveries" ADD COLUMN "handedOverAt" TIMESTAMP(3);
ALTER TABLE "deliveries" ADD COLUMN "handedOverByUserId" TEXT;

-- AlterTable: NULL for guests. Guest checkout stays the default path — an account
-- is a convenience offered after the order, never a toll gate before it.
ALTER TABLE "customers" ADD COLUMN "clerkUserId" TEXT;

-- CreateTable: saved addresses. The entire reason to have an account.
CREATE TABLE "customer_addresses" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "street" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    -- Buzzer codes, gate instructions. What actually determines a successful drop.
    "notes" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_addresses_customerId_idx" ON "customer_addresses"("customerId");

-- One customer record per account per restaurant.
-- CreateIndex
CREATE UNIQUE INDEX "customers_restaurantId_clerkUserId_key" ON "customers"("restaurantId", "clerkUserId");

-- CreateIndex
CREATE INDEX "customers_clerkUserId_idx" ON "customers"("clerkUserId");

-- AddForeignKey
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
