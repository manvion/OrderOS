import type { PrismaClient, Prisma } from '@prisma/client';

type LoyaltyClient = PrismaClient | Prisma.TransactionClient;

/** Points earned on the food subtotal only -- not tax, tip, or delivery fee. */
export function pointsForSubtotal(subtotalCents: number, pointsPerDollar: number): number {
  return Math.floor(subtotalCents / 100) * pointsPerDollar;
}

/**
 * Credits or claws back points on a customer's balance. `sign: 1` credits
 * (order paid), `sign: -1` claws back (that paid order was cancelled or
 * fully refunded), clamped at 0 so a customer who already spent points
 * elsewhere never goes negative.
 *
 * A no-op for guest orders with no customer record -- there's nowhere to
 * park the points, same as a guest never rolling up totalOrders/totalSpentCents.
 */
export async function applyLoyaltyDelta(
  client: LoyaltyClient,
  customerId: string | null | undefined,
  points: number,
  sign: 1 | -1,
): Promise<void> {
  if (!customerId || points <= 0) return;
  const delta = sign * points;

  if (sign === -1) {
    await client.$executeRaw`
      UPDATE "customers" SET "loyaltyPoints" = GREATEST("loyaltyPoints" + ${delta}, 0) WHERE "id" = ${customerId}
    `;
  } else {
    await client.$executeRaw`
      UPDATE "customers" SET "loyaltyPoints" = "loyaltyPoints" + ${delta} WHERE "id" = ${customerId}
    `;
  }
}
