-- The platform admin: US, not the restaurants.
--
-- Deliberately a SEPARATE table from `users`. `users` is a MEMBERSHIP — it binds a
-- Clerk identity to exactly one restaurant, and every tenant-scoped query hangs off
-- it. If platform admins were just users with a special role, then "may this person
-- see this restaurant's orders?" and "does this person work for us?" would be the
-- same question, and one fat-fingered role would turn a line cook into a platform
-- operator.

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT');

-- CreateTable
CREATE TABLE "platform_admins" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "PlatformRole" NOT NULL DEFAULT 'SUPPORT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable: a platform admin acting inside a restaurant's dashboard to help them.
--
-- Support access is a loaded gun — it lets one of our employees read a restaurant's
-- customers, orders and revenue. So every session is opened explicitly, carries a
-- written reason, expires on its own, and lands on the RESTAURANT'S own audit log.
-- A support tool the customer cannot see us using is a surveillance tool.
CREATE TABLE "support_sessions" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "adminEmail" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_clerkUserId_key" ON "platform_admins"("clerkUserId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_admins_email_key" ON "platform_admins"("email");

-- CreateIndex
CREATE INDEX "platform_admins_clerkUserId_idx" ON "platform_admins"("clerkUserId");

-- CreateIndex
CREATE INDEX "support_sessions_restaurantId_createdAt_idx" ON "support_sessions"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "support_sessions_adminId_createdAt_idx" ON "support_sessions"("adminId", "createdAt");
