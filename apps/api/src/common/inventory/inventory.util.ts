import type { PrismaClient, Prisma } from '@prisma/client';

type InventoryClient = PrismaClient | Prisma.TransactionClient;

/**
 * Applies a stock delta to every line item whose product has trackInventory
 * on. Products that don't track inventory (the vast majority -- a dish made
 * to order has no count) are untouched by the WHERE clause.
 *
 * Single UPDATE per product, clamped server-side with GREATEST/CASE so two
 * concurrent orders racing the same product's last unit can't push it
 * negative -- there is no read-then-write gap for a second request to land in.
 *
 * `sign: -1` decrements (order paid), `sign: 1` restores (paid order cancelled).
 * Restoring re-enables a product that a stockout had auto-hidden; it never
 * touches a product the owner hid for an unrelated reason (stock stays 0 for
 * those, since GREATEST(0 + 0, 0) = 0).
 */
export async function applyInventoryDelta(
  client: InventoryClient,
  items: Array<{ productId: string | null; quantity: number }>,
  sign: 1 | -1,
): Promise<void> {
  for (const item of items) {
    if (!item.productId || item.quantity <= 0) continue;
    const delta = sign * item.quantity;
    if (sign === -1) {
      await client.$executeRaw`
        UPDATE "products"
        SET "stockQuantity" = GREATEST("stockQuantity" + ${delta}, 0),
            "isAvailable" = CASE WHEN "stockQuantity" + ${delta} <= 0 THEN false ELSE "isAvailable" END
        WHERE "id" = ${item.productId} AND "trackInventory" = true
      `;
    } else {
      await client.$executeRaw`
        UPDATE "products"
        SET "stockQuantity" = "stockQuantity" + ${delta},
            "isAvailable" = CASE WHEN "stockQuantity" + ${delta} > 0 THEN true ELSE "isAvailable" END
        WHERE "id" = ${item.productId} AND "trackInventory" = true
      `;
    }
  }
}
