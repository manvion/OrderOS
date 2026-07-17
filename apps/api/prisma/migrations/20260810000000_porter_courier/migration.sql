-- Porter — an India intracity courier, since Uber Direct / DoorDash Drive don't
-- operate there. Additive: existing restaurants keep their couriers unchanged.

-- AlterEnum
ALTER TYPE "DeliveryProvider" ADD VALUE 'PORTER';

-- AlterTable
ALTER TABLE "restaurants"
  ADD COLUMN "porterEnabled" BOOLEAN NOT NULL DEFAULT false;
