import type { PrismaClient, Prisma, CashMovementType } from '@prisma/client';

type CashClient = PrismaClient | Prisma.TransactionClient;

/**
 * A human-readable name for a staff member, snapshotted onto cash records so a closed
 * shift's report still reads correctly even if that person is later removed. Falls back
 * to the email, then to "Staff", so it is never blank.
 */
export async function resolveUserName(client: CashClient, userId: string): Promise<string> {
  const user = await client.user.findUnique({
    where: { id: userId },
    select: { firstName: true, lastName: true, email: true },
  });
  if (!user) return 'Staff';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email || 'Staff';
}

/**
 * Records a cash movement against the restaurant's OPEN drawer session, if one exists.
 *
 * Deliberately a no-op when no drawer is open: cash tracking is opt-in. A restaurant
 * that never opens a drawer just isn't running a till, and a cash sale still succeeds —
 * it simply doesn't land in a Z-report that isn't being kept. This mirrors how
 * applyInventoryDelta only touches products that opted into stock tracking.
 *
 * Runs inside the same transaction as the order/payment write, so a cash settlement and
 * its drawer entry commit together — the drawer can never disagree with the orders.
 */
export async function recordCashMovement(
  client: CashClient,
  input: {
    restaurantId: string;
    type: CashMovementType;
    /** Always positive; `type` says whether it adds to or removes from the drawer. */
    amountCents: number;
    createdById: string;
    orderId?: string;
    reason?: string;
  },
): Promise<void> {
  if (input.amountCents <= 0) return;

  const open = await client.cashSession.findFirst({
    where: { restaurantId: input.restaurantId, status: 'OPEN' },
    select: { id: true },
    orderBy: { openedAt: 'desc' },
  });
  if (!open) return; // no till running — nothing to record

  await client.cashMovement.create({
    data: {
      sessionId: open.id,
      type: input.type,
      amountCents: input.amountCents,
      createdById: input.createdById,
      createdByName: await resolveUserName(client, input.createdById),
      orderId: input.orderId,
      reason: input.reason,
    },
  });
}
