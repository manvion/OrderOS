-- Website Integration module: an embeddable ordering widget for restaurants that
-- already have a website (WordPress, Wix, Squarespace, hand-written HTML).

-- CreateEnum
CREATE TYPE "WidgetEventType" AS ENUM ('VIEW', 'OPEN', 'ADD_TO_CART', 'CHECKOUT_START', 'ORDER_CREATED');

-- CreateTable
CREATE TABLE "website_integrations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "widgetKey" TEXT NOT NULL,
    "allowedDomains" TEXT[],
    "settings" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "installedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "widget_events" (
    "type" "WidgetEventType" NOT NULL,
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "origin" TEXT,
    "orderId" TEXT,
    "integrationId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_events_pkey" PRIMARY KEY ("id")
);

-- AlterTable: attribute an order to the website that produced it. Nullable,
-- because storefront and QR orders have no website.
ALTER TABLE "orders" ADD COLUMN "websiteIntegrationId" TEXT;

-- The widget key is the lookup path on every single widget request.
-- CreateIndex
CREATE UNIQUE INDEX "website_integrations_widgetKey_key" ON "website_integrations"("widgetKey");

-- CreateIndex
CREATE INDEX "website_integrations_restaurantId_idx" ON "website_integrations"("restaurantId");

-- CreateIndex
CREATE INDEX "widget_events_integrationId_type_createdAt_idx" ON "widget_events"("integrationId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "widget_events_restaurantId_createdAt_idx" ON "widget_events"("restaurantId", "createdAt");

-- One row per session per event type. This is what makes the conversion rate
-- honest: without it, a customer who opens the widget five times counts as five
-- opens, and the denominator inflates the more engaged your customers are.
-- CreateIndex
CREATE UNIQUE INDEX "widget_events_integrationId_sessionId_type_key" ON "widget_events"("integrationId", "sessionId", "type");

-- CreateIndex
CREATE INDEX "orders_websiteIntegrationId_idx" ON "orders"("websiteIntegrationId");

-- AddForeignKey
ALTER TABLE "website_integrations" ADD CONSTRAINT "website_integrations_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "website_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE: deleting an integration must lose its attribution, never
-- its orders. A restaurant removing a website they no longer use must not delete
-- the revenue that website produced.
-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_websiteIntegrationId_fkey" FOREIGN KEY ("websiteIntegrationId") REFERENCES "website_integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
