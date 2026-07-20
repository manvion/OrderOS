import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CashMovementType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { resolveUserName } from '../../common/cash/cash.util';

/** How each movement type moves the drawer: sales/pay-ins add cash, refunds/pay-outs remove it. */
const SIGN: Record<CashMovementType, 1 | -1> = {
  SALE: 1,
  PAY_IN: 1,
  REFUND: -1,
  PAY_OUT: -1,
};

@Injectable()
export class CashService {
  private readonly logger = new Logger(CashService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The drawer currently open for this restaurant, with its movements — or null. */
  async current(restaurantId: string) {
    const session = await this.prisma.cashSession.findFirst({
      where: { restaurantId, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
      include: { movements: { orderBy: { createdAt: 'desc' } } },
    });
    return session ? this.withTotals(session) : null;
  }

  /** Recent closed shifts, for the Z-report history. */
  async history(restaurantId: string, limit = 30) {
    const sessions = await this.prisma.cashSession.findMany({
      where: { restaurantId, status: 'CLOSED' },
      orderBy: { closedAt: 'desc' },
      take: Math.min(limit, 100),
      include: { movements: { orderBy: { createdAt: 'desc' } } },
    });
    return sessions.map((s) => this.withTotals(s));
  }

  /** Open a drawer with a counted float. One open drawer per restaurant at a time. */
  async open(restaurantId: string, userId: string, openingFloatCents: number) {
    const existing = await this.prisma.cashSession.findFirst({
      where: { restaurantId, status: 'OPEN' },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('A cash drawer is already open. Close it before opening a new one.');
    }

    const session = await this.prisma.cashSession.create({
      data: {
        restaurantId,
        openingFloatCents: Math.max(0, Math.round(openingFloatCents)),
        openedById: userId,
        openedByName: await resolveUserName(this.prisma, userId),
      },
      include: { movements: true },
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'cash.drawer_opened',
      entityType: 'CashSession',
      entityId: session.id,
      metadata: { openingFloatCents: session.openingFloatCents },
    });
    return this.withTotals(session);
  }

  /**
   * A manual pay-in or pay-out — money into or out of the drawer that isn't a sale or a
   * refund (extra change added, petty cash taken, a supplier paid from the till).
   */
  async addMovement(
    restaurantId: string,
    userId: string,
    input: { type: 'PAY_IN' | 'PAY_OUT'; amountCents: number; reason?: string },
  ) {
    const session = await this.requireOpen(restaurantId);
    const amountCents = Math.round(input.amountCents);
    if (amountCents <= 0) throw new BadRequestException('Amount must be greater than zero');

    await this.prisma.cashMovement.create({
      data: {
        sessionId: session.id,
        type: input.type,
        amountCents,
        reason: input.reason?.trim() || null,
        createdById: userId,
        createdByName: await resolveUserName(this.prisma, userId),
      },
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: input.type === 'PAY_IN' ? 'cash.pay_in' : 'cash.pay_out',
      entityType: 'CashSession',
      entityId: session.id,
      metadata: { amountCents, reason: input.reason },
    });
    return this.current(restaurantId);
  }

  /**
   * Close the drawer: staff count the physical cash, and we record it against what the
   * movements say should be there. The difference (over/short) is the number a manager
   * actually cares about at end of day.
   */
  async close(restaurantId: string, userId: string, countedCashCents: number) {
    const session = await this.requireOpen(restaurantId);
    const totals = await this.totalsFor(session.id, session.openingFloatCents);
    const counted = Math.max(0, Math.round(countedCashCents));

    const closed = await this.prisma.cashSession.update({
      where: { id: session.id },
      data: {
        status: 'CLOSED',
        countedCashCents: counted,
        expectedCashCents: totals.expectedCashCents,
        overShortCents: counted - totals.expectedCashCents,
        closedById: userId,
        closedByName: await resolveUserName(this.prisma, userId),
        closedAt: new Date(),
      },
      include: { movements: { orderBy: { createdAt: 'desc' } } },
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'cash.drawer_closed',
      entityType: 'CashSession',
      entityId: session.id,
      metadata: {
        expectedCashCents: totals.expectedCashCents,
        countedCashCents: counted,
        overShortCents: counted - totals.expectedCashCents,
      },
    });
    this.logger.log(
      `Cash drawer ${session.id} closed — expected ${totals.expectedCashCents}, counted ${counted} (${counted - totals.expectedCashCents >= 0 ? 'over' : 'short'})`,
    );
    return this.withTotals(closed);
  }

  // --- internals -------------------------------------------------------------

  private async requireOpen(restaurantId: string) {
    const session = await this.prisma.cashSession.findFirst({
      where: { restaurantId, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });
    if (!session) throw new NotFoundException('No cash drawer is open');
    return session;
  }

  private async totalsFor(sessionId: string, openingFloatCents: number) {
    const grouped = await this.prisma.cashMovement.groupBy({
      by: ['type'],
      where: { sessionId },
      _sum: { amountCents: true },
    });
    const sumOf = (t: CashMovementType) =>
      grouped.find((g) => g.type === t)?._sum.amountCents ?? 0;

    const salesCents = sumOf('SALE');
    const refundsCents = sumOf('REFUND');
    const payInsCents = sumOf('PAY_IN');
    const payOutsCents = sumOf('PAY_OUT');
    const expectedCashCents =
      openingFloatCents + salesCents + payInsCents - refundsCents - payOutsCents;

    return { salesCents, refundsCents, payInsCents, payOutsCents, expectedCashCents };
  }

  /** Attach the running totals + expected-in-drawer to a session for the client. */
  private async withTotals<
    T extends { id: string; openingFloatCents: number },
  >(session: T) {
    const totals = await this.totalsFor(session.id, session.openingFloatCents);
    return { ...session, ...totals };
  }
}
