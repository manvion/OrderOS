-- Catering & parties: per-head packages paid online, plus custom quote requests.
CREATE TYPE "CateringType" AS ENUM ('PACKAGE', 'CUSTOM');
CREATE TYPE "CateringStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

CREATE TABLE "catering_packages" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "pricePerPersonCents" INTEGER NOT NULL,
    "minPeople" INTEGER NOT NULL DEFAULT 10,
    "maxPeople" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catering_packages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catering_packages_restaurantId_isActive_sortOrder_idx" ON "catering_packages"("restaurantId", "isActive", "sortOrder");

CREATE TABLE "catering_requests" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "type" "CateringType" NOT NULL,
    "status" "CateringStatus" NOT NULL DEFAULT 'NEW',
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "headCount" INTEGER NOT NULL,
    "eventDate" TIMESTAMP(3) NOT NULL,
    "fulfillment" "FulfillmentType" NOT NULL DEFAULT 'PICKUP',
    "deliveryAddress" TEXT,
    "message" TEXT,
    "packageId" TEXT,
    "packageName" TEXT,
    "pricePerPersonCents" INTEGER,
    "totalCents" INTEGER,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paymentProvider" TEXT,
    "stripeSessionId" TEXT,
    "razorpayOrderId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catering_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "catering_requests_restaurantId_status_createdAt_idx" ON "catering_requests"("restaurantId", "status", "createdAt");
CREATE INDEX "catering_requests_stripeSessionId_idx" ON "catering_requests"("stripeSessionId");

ALTER TABLE "catering_packages" ADD CONSTRAINT "catering_packages_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catering_requests" ADD CONSTRAINT "catering_requests_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "catering_requests" ADD CONSTRAINT "catering_requests_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "catering_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
