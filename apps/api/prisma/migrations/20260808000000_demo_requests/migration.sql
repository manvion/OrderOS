-- Inbound "book a demo" / done-for-you setup leads from the marketing site.
-- These are NOT tenants — nobody has signed up. They sit in their own table so a
-- stranger submitting a form can never reach anything a real restaurant owns.

-- CreateEnum
CREATE TYPE "DemoRequestStatus" AS ENUM ('NEW', 'CONTACTED', 'SCHEDULED', 'WON', 'LOST');

-- CreateTable
CREATE TABLE "demo_requests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "restaurantName" TEXT,
    "city" TEXT,
    "message" TEXT,
    "interest" TEXT,
    "status" "DemoRequestStatus" NOT NULL DEFAULT 'NEW',
    "handledByAdmin" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "demo_requests_status_createdAt_idx" ON "demo_requests"("status", "createdAt");
