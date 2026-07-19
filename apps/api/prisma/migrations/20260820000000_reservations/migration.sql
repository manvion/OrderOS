-- Table reservations: "simple capacity per slot".

-- Per-restaurant reservation settings.
ALTER TABLE "restaurants" ADD COLUMN "reservationsEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "reservationCapacityPerSlot" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "restaurants" ADD COLUMN "reservationSlotMinutes" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "restaurants" ADD COLUMN "reservationMaxPartySize" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "restaurants" ADD COLUMN "reservationLeadHours" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "restaurants" ADD COLUMN "reservationWindowDays" INTEGER NOT NULL DEFAULT 30;

-- Reservation status.
CREATE TYPE "ReservationStatus" AS ENUM ('CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- The bookings themselves.
CREATE TABLE "reservations" (
  "id" TEXT NOT NULL,
  "restaurantId" TEXT NOT NULL,
  "status" "ReservationStatus" NOT NULL DEFAULT 'CONFIRMED',
  "customerName" TEXT NOT NULL,
  "customerPhone" TEXT NOT NULL,
  "customerEmail" TEXT,
  "partySize" INTEGER NOT NULL,
  "reservedAt" TIMESTAMP(3) NOT NULL,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reservations_restaurantId_reservedAt_idx" ON "reservations" ("restaurantId", "reservedAt");
CREATE INDEX "reservations_restaurantId_status_reservedAt_idx" ON "reservations" ("restaurantId", "status", "reservedAt");

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_restaurantId_fkey"
  FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
