-- Notification engine (both audiences + delivery log + SMS opt-out),
-- live courier map (breadcrumb trail), and staff invitations.

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationAudience" AS ENUM ('CUSTOMER', 'RESTAURANT');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

-- AlterTable: where the RESTAURANT is alerted. Distinct from the public
-- phone/email shown to customers — the number woken at 8pm is the pass phone.
ALTER TABLE "restaurants" ADD COLUMN "notifyPhone" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "notifyEmail" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "notifySmsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN "notifyEmailEnabled" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: a STOP reply is absolute — it silences ALL SMS to this customer,
-- transactional included. Honouring it only for marketing gets a number blocked.
ALTER TABLE "customers" ADD COLUMN "smsOptOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "smsOptOutAt" TIMESTAMP(3);

-- CreateTable: every message attempted, and what happened to it. "The customer
-- says they never got the text" is the most common support ticket in this
-- industry, and without this the only honest answer is a shrug.
CREATE TABLE "notification_logs" (
    "id" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "audience" "NotificationAudience" NOT NULL,
    "status" "NotificationStatus" NOT NULL,
    "template" TEXT NOT NULL,
    -- Masked at write time ("***0188"). A log of every customer's phone number
    -- is a breach waiting to happen.
    "recipient" TEXT NOT NULL,
    "providerId" TEXT,
    "error" TEXT,
    "orderId" TEXT,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: the courier's breadcrumb trail, so the customer's map draws the
-- route the driver actually took instead of teleporting a pin around.
CREATE TABLE "courier_pings" (
    "id" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "courier_pings_pkey" PRIMARY KEY ("id")
);

-- CreateTable: without invitations the only User a restaurant could ever have was
-- its founder, which made the whole RBAC system decorative.
CREATE TABLE "staff_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL DEFAULT 'STAFF',
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "invitedByUserId" TEXT,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_logs_restaurantId_createdAt_idx" ON "notification_logs"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_logs_orderId_idx" ON "notification_logs"("orderId");

-- CreateIndex
CREATE INDEX "courier_pings_deliveryId_createdAt_idx" ON "courier_pings"("deliveryId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_token_key" ON "staff_invites"("token");

-- CreateIndex
CREATE INDEX "staff_invites_token_idx" ON "staff_invites"("token");

-- One live invite per email per restaurant: re-inviting refreshes the link
-- rather than stacking duplicates.
-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_restaurantId_email_key" ON "staff_invites"("restaurantId", "email");

-- AddForeignKey
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courier_pings" ADD CONSTRAINT "courier_pings_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
