import { BadRequestException, Injectable } from '@nestjs/common';
import type { Promotion } from '@prisma/client';
import { formatMoney, planAllows, type PromotionInput } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { assertRestaurantCapability, isMissingPlanColumn } from '../../common/plan/plan.util';

export interface ResolvedDiscount {
  promotionId: string;
  discountCents: number;
}

export interface PricedItemForPromo {
  productId: string;
  lineTotalCents: number;
}

export interface ActivePromotionForMenu {
  /** Empty = every product on the menu carries this tag. */
  productIds: string[];
  /** e.g. "10% OFF", "$5 OFF". */
  label: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
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
    await assertRestaurantCapability(this.prisma, restaurantId, 'PROMOTIONS');

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
        productIds: input.productIds,
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

  private withinWindow(p: Pick<Promotion, 'startsAt' | 'endsAt'>, now: Date): boolean {
    return (!p.startsAt || p.startsAt <= now) && (!p.endsAt || p.endsAt >= now);
  }

  /** What a promotion discounts against: the whole cart, or just its named products. */
  private discountBaseCents(promo: Pick<Promotion, 'productIds'>, items: PricedItemForPromo[]): number {
    if (promo.productIds.length === 0) return items.reduce((sum, i) => sum + i.lineTotalCents, 0);
    return items
      .filter((i) => promo.productIds.includes(i.productId))
      .reduce((sum, i) => sum + i.lineTotalCents, 0);
  }

  private discountAmountCents(promo: Pick<Promotion, 'type' | 'value'>, baseCents: number): number {
    return promo.type === 'PERCENT'
      ? Math.floor((baseCents * promo.value) / 10_000)
      : Math.min(promo.value, baseCents);
  }

  /**
   * The one place a discount gets decided, for both the storefront cart's live
   * preview and the real order at checkout — never trust a discount the client
   * computed itself.
   *
   * Auto-apply promotions (code null) are always in the running. A customer-
   * entered code is validated strictly: a code that doesn't exist, doesn't meet
   * the order minimum, or has expired throws, so the cart can tell the customer
   * exactly why instead of silently applying nothing. A promotion scoped to
   * specific products (see productIds on the model) only discounts -- and only
   * counts as a candidate at all -- when one of those products is actually in
   * the cart; a $5-off-the-fries promo does nothing for a cart with no fries.
   */
  async resolveDiscount(
    restaurantId: string,
    items: PricedItemForPromo[],
    code: string | undefined,
    currency: string,
  ): Promise<ResolvedDiscount | null> {
    // The plan is the source of truth: a restaurant that built promos on a tier that
    // includes them and then dropped to one that doesn't stops applying them —
    // regardless of the promos still sitting active in the table. Resilient: a
    // missing plan column (migration not applied) leaves promotions working.
    let promotionsAllowed = true;
    try {
      const r = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { planTier: true },
      });
      if (r) promotionsAllowed = planAllows(r.planTier, 'PROMOTIONS');
    } catch (err) {
      if (!isMissingPlanColumn(err)) throw err;
    }
    if (!promotionsAllowed) {
      if (code?.trim()) throw new BadRequestException('That code is not valid');
      return null;
    }

    const now = new Date();
    const subtotalCents = items.reduce((sum, i) => sum + i.lineTotalCents, 0);

    const autoApply = (
      await this.prisma.promotion.findMany({
        where: { restaurantId, isActive: true, code: null },
      })
    ).filter((p) => this.withinWindow(p, now) && subtotalCents >= p.minSubtotalCents);

    let coded: Promotion | null = null;
    const trimmedCode = code?.trim();
    if (trimmedCode) {
      coded = await this.prisma.promotion.findFirst({
        where: { restaurantId, isActive: true, code: trimmedCode.toUpperCase() },
      });
      if (!coded) throw new BadRequestException('That code is not valid');
      if (!this.withinWindow(coded, now)) throw new BadRequestException('That code has expired');
      if (subtotalCents < coded.minSubtotalCents) {
        throw new BadRequestException(
          `That code needs a minimum order of ${formatMoney(coded.minSubtotalCents, currency)}`,
        );
      }
    }

    const candidates = coded ? [...autoApply, coded] : autoApply;

    const scored = candidates
      .map((p) => ({ promotionId: p.id, discountCents: this.discountAmountCents(p, this.discountBaseCents(p, items)) }))
      .filter((s) => s.discountCents > 0);

    if (scored.length === 0) {
      // A code that matched but covers products not in the cart: still an
      // explicit "no" the customer should see, not a silent non-effect.
      if (coded && coded.productIds.length > 0) {
        throw new BadRequestException('That code only applies to specific items not in your cart');
      }
      return null;
    }

    return scored.reduce((best, current) =>
      current.discountCents > best.discountCents ? current : best,
    );
  }

  /**
   * What the storefront menu badges look like right now: every active,
   * in-window promotion, which products it tags, and with what label.
   * MenuService combines this with the product list -- an empty productIds
   * promotion tags every product it sees, and where more than one promotion
   * covers a product, MenuService picks the one that saves the most.
   */
  async getActivePromotionsForMenu(restaurantId: string): Promise<ActivePromotionForMenu[]> {
    const now = new Date();
    const [active, restaurant] = await Promise.all([
      this.prisma.promotion
        .findMany({ where: { restaurantId, isActive: true } })
        .then((all) => all.filter((p) => this.withinWindow(p, now))),
      this.prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { currency: true } }),
    ]);
    const currency = restaurant.currency;

    return active.map((p) => ({
      productIds: p.productIds,
      type: p.type,
      value: p.value,
      label: p.type === 'PERCENT' ? `${p.value / 100}% OFF` : `${formatMoney(p.value, currency)} OFF`,
    }));
  }

  /** Called once an order carrying this promotion actually lands. */
  recordRedemption(promotionId: string) {
    return this.prisma.promotion.update({
      where: { id: promotionId },
      data: { redemptions: { increment: 1 } },
    });
  }
}
