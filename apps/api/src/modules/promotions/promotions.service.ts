import { BadRequestException, Injectable } from '@nestjs/common';
import type { Promotion } from '@prisma/client';
import { formatMoney, type PromotionInput } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface ResolvedDiscount {
  promotionId: string;
  discountCents: number;
}

@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  list(restaurantId: string) {
    return this.prisma.promotion.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(restaurantId: string, input: PromotionInput) {
    const code = input.code?.trim().toUpperCase() || null;
    if (code) {
      const existing = await this.prisma.promotion.findFirst({
        where: { restaurantId, code },
      });
      if (existing) throw new BadRequestException('A promotion with that code already exists');
    }

    return this.prisma.promotion.create({
      data: {
        restaurantId,
        name: input.name,
        type: input.type,
        value: input.value,
        code,
        minSubtotalCents: input.minSubtotalCents,
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
      },
    });
  }

  async setActive(restaurantId: string, id: string, isActive: boolean) {
    const promo = await this.prisma.promotion.findFirst({ where: { id, restaurantId } });
    if (!promo) throw new BadRequestException('Promotion not found');
    return this.prisma.promotion.update({ where: { id }, data: { isActive } });
  }

  async remove(restaurantId: string, id: string) {
    const promo = await this.prisma.promotion.findFirst({ where: { id, restaurantId } });
    if (!promo) throw new BadRequestException('Promotion not found');
    await this.prisma.promotion.delete({ where: { id } });
  }

  /**
   * The one place a discount gets decided, for both the storefront cart's live
   * preview and the real order at checkout — never trust a discount the client
   * computed itself.
   *
   * Auto-apply promotions (code null) are always in the running. A customer-
   * entered code is validated strictly: a code that doesn't exist, doesn't meet
   * the order minimum, or has expired throws, so the cart can tell the customer
   * exactly why instead of silently applying nothing.
   */
  async resolveDiscount(
    restaurantId: string,
    subtotalCents: number,
    code: string | undefined,
    currency: string,
  ): Promise<ResolvedDiscount | null> {
    const now = new Date();
    const withinWindow = (p: Pick<Promotion, 'startsAt' | 'endsAt'>) =>
      (!p.startsAt || p.startsAt <= now) && (!p.endsAt || p.endsAt >= now);

    const autoApply = (
      await this.prisma.promotion.findMany({
        where: { restaurantId, isActive: true, code: null },
      })
    ).filter((p) => withinWindow(p) && subtotalCents >= p.minSubtotalCents);

    let coded: Promotion | null = null;
    const trimmedCode = code?.trim();
    if (trimmedCode) {
      coded = await this.prisma.promotion.findFirst({
        where: { restaurantId, isActive: true, code: trimmedCode.toUpperCase() },
      });
      if (!coded) throw new BadRequestException('That code is not valid');
      if (!withinWindow(coded)) throw new BadRequestException('That code has expired');
      if (subtotalCents < coded.minSubtotalCents) {
        throw new BadRequestException(
          `That code needs a minimum order of ${formatMoney(coded.minSubtotalCents, currency)}`,
        );
      }
    }

    const candidates = coded ? [...autoApply, coded] : autoApply;
    if (candidates.length === 0) return null;

    const scored = candidates.map((p) => ({
      promotionId: p.id,
      discountCents:
        p.type === 'PERCENT'
          ? Math.floor((subtotalCents * p.value) / 10_000)
          : Math.min(p.value, subtotalCents),
    }));

    return scored.reduce((best, current) =>
      current.discountCents > best.discountCents ? current : best,
    );
  }

  /** Called once an order carrying this promotion actually lands. */
  recordRedemption(promotionId: string) {
    return this.prisma.promotion.update({
      where: { id: promotionId },
      data: { redemptions: { increment: 1 } },
    });
  }
}
