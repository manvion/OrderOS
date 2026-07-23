-- AlterTable: the courier staff chose for a POS delivery order, so marking it READY
-- auto-dispatches to that provider instead of waiting for a manual choice.
ALTER TABLE "orders" ADD COLUMN "preferredCourier" "DeliveryProvider";
