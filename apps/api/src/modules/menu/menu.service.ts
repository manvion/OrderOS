import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CategoryInput, ProductInput } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { StorageService } from '../storage/storage.service';
import { PromotionsService, type ActivePromotionForMenu } from '../promotions/promotions.service';

const MENU_CACHE_TTL_SECONDS = 120;

export interface MenuProductRow {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
  modifierGroups: unknown[];
}

export interface MenuCategoryRow {
  id: string;
  name: string;
  description: string | null;
  products: MenuProductRow[];
}

/**
 * Attach each product's best-savings badge, computed fresh every request (see
 * getPublicMenu). A promotion with an empty productIds tags every product; one
 * scoped to specific products tags only those. If more than one promotion
 * covers a product, the one that would save the most wins the badge.
 */
function withPromoBadges(menu: MenuCategoryRow[], promotions: ActivePromotionForMenu[]) {
  if (promotions.length === 0) return menu;

  const labelFor = (product: MenuProductRow): string | null => {
    let best: { savingsCents: number; label: string } | null = null;
    for (const promo of promotions) {
      if (promo.productIds.length > 0 && !promo.productIds.includes(product.id)) continue;
      const savingsCents =
        promo.type === 'PERCENT'
          ? Math.floor((product.priceCents * promo.value) / 10_000)
          : Math.min(promo.value, product.priceCents);
      if (!best || savingsCents > best.savingsCents) best = { savingsCents, label: promo.label };
    }
    return best?.label ?? null;
  };

  return menu.map((category) => ({
    ...category,
    products: category.products.map((product) => ({ ...product, promoLabel: labelFor(product) })),
  }));
}

@Injectable()
export class MenuService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly promotions: PromotionsService,
  ) {}

  /** The currency menu prices are in — the photo importer reads numbers against it. */
  async getRestaurantCurrency(restaurantId: string) {
    return this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { currency: true },
    });
  }

  // --- Categories -----------------------------------------------------------

  async listCategories(restaurantId: string) {
    return this.prisma.category.findMany({
      where: { restaurantId },
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async createCategory(restaurantId: string, input: CategoryInput) {
    const category = await this.prisma.category.create({
      data: { ...input, restaurantId },
    });
    await this.invalidate(restaurantId);
    return category;
  }

  async updateCategory(restaurantId: string, id: string, input: Partial<CategoryInput>) {
    // The compound where is the tenant check: updating a category that belongs to
    // another restaurant matches zero rows and 404s rather than succeeding.
    const existing = await this.prisma.category.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Category not found');

    const category = await this.prisma.category.update({ where: { id }, data: input });
    await this.invalidate(restaurantId);
    return category;
  }

  async deleteCategory(restaurantId: string, id: string) {
    const existing = await this.prisma.category.findFirst({
      where: { id, restaurantId },
      include: { _count: { select: { products: true } } },
    });
    if (!existing) throw new NotFoundException('Category not found');

    if (existing._count.products > 0) {
      throw new BadRequestException(
        `This category still holds ${existing._count.products} product(s). Move or delete them first.`,
      );
    }

    await this.prisma.category.delete({ where: { id } });
    await this.invalidate(restaurantId);
  }

  async reorderCategories(restaurantId: string, orderedIds: string[]) {
    const owned = await this.prisma.category.count({
      where: { id: { in: orderedIds }, restaurantId },
    });
    if (owned !== orderedIds.length) {
      throw new BadRequestException('One or more categories do not belong to this restaurant');
    }

    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.category.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    await this.invalidate(restaurantId);
  }

  // --- Products -------------------------------------------------------------

  async listProducts(restaurantId: string, categoryId?: string) {
    return this.prisma.product.findMany({
      where: { restaurantId, ...(categoryId ? { categoryId } : {}) },
      orderBy: [{ categoryId: 'asc' }, { sortOrder: 'asc' }],
      include: {
        category: { select: { id: true, name: true } },
        modifierGroups: {
          orderBy: { sortOrder: 'asc' },
          include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
  }

  async getProduct(restaurantId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, restaurantId },
      include: {
        category: true,
        modifierGroups: {
          orderBy: { sortOrder: 'asc' },
          include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
        },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  /**
   * Create a product with its modifier groups in one shot. Nested writes run in
   * a single transaction, so a product can never exist with half its "Size"
   * options — which would let a customer order a burger with no size.
   */
  async createProduct(restaurantId: string, input: ProductInput) {
    const category = await this.prisma.category.findFirst({
      where: { id: input.categoryId, restaurantId },
    });
    if (!category) throw new NotFoundException('Category not found');

    const { modifierGroups, ...productData } = input;

    const product = await this.prisma.product.create({
      data: {
        ...productData,
        restaurantId,
        modifierGroups: {
          create: modifierGroups.map((group) => ({
            name: group.name,
            selectionType: group.selectionType,
            required: group.required,
            minSelections: group.minSelections,
            maxSelections: group.maxSelections,
            sortOrder: group.sortOrder,
            restaurantId,
            modifiers: {
              create: group.modifiers.map((m) => ({
                name: m.name,
                priceCents: m.priceCents,
                isAvailable: m.isAvailable,
                sortOrder: m.sortOrder,
              })),
            },
          })),
        },
      },
      include: {
        modifierGroups: { include: { modifiers: true } },
      },
    });

    await this.invalidate(restaurantId);
    return product;
  }

  /**
   * Update a product. Modifier groups are replaced wholesale when supplied:
   * simpler and safer than a diff, and it means the payload the edit form sends
   * is exactly the state the product ends in. Historical orders are unaffected
   * because OrderItemModifier snapshots the name and price at checkout.
   */
  async updateProduct(restaurantId: string, id: string, input: Partial<ProductInput>) {
    const existing = await this.prisma.product.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Product not found');

    if (input.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: input.categoryId, restaurantId },
      });
      if (!category) throw new NotFoundException('Category not found');
    }

    const { modifierGroups, ...productData } = input;

    const product = await this.prisma.$transaction(async (tx) => {
      if (modifierGroups) {
        await tx.modifierGroup.deleteMany({ where: { productId: id } });
        for (const group of modifierGroups) {
          await tx.modifierGroup.create({
            data: {
              name: group.name,
              selectionType: group.selectionType,
              required: group.required,
              minSelections: group.minSelections,
              maxSelections: group.maxSelections,
              sortOrder: group.sortOrder,
              productId: id,
              restaurantId,
              modifiers: {
                create: group.modifiers.map((m) => ({
                  name: m.name,
                  priceCents: m.priceCents,
                  isAvailable: m.isAvailable,
                  sortOrder: m.sortOrder,
                })),
              },
            },
          });
        }
      }

      return tx.product.update({
        where: { id },
        data: productData,
        include: {
          modifierGroups: {
            orderBy: { sortOrder: 'asc' },
            include: { modifiers: { orderBy: { sortOrder: 'asc' } } },
          },
        },
      });
    });

    await this.invalidate(restaurantId);
    return product;
  }

  /** The 86 button. The most-used control in the whole dashboard. */
  async setAvailability(restaurantId: string, id: string, isAvailable: boolean) {
    const existing = await this.prisma.product.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Product not found');

    const product = await this.prisma.product.update({
      where: { id },
      data: { isAvailable },
    });
    await this.invalidate(restaurantId);
    return product;
  }

  async deleteProduct(restaurantId: string, id: string) {
    const existing = await this.prisma.product.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Product not found');

    // Hard delete is safe: OrderItem.productId is SetNull and the item carries a
    // name/price snapshot, so receipts survive the product's deletion intact.
    await this.prisma.product.delete({ where: { id } });
    await this.invalidate(restaurantId);
  }

  async uploadProductImage(restaurantId: string, id: string, file: Express.Multer.File) {
    const existing = await this.prisma.product.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Product not found');

    const { url } = await this.storage.upload(
      file.buffer,
      file.mimetype,
      `restaurants/${restaurantId}/products`,
    );
    const product = await this.prisma.product.update({
      where: { id },
      data: { imageUrl: url },
    });
    await this.invalidate(restaurantId);
    return { imageUrl: product.imageUrl };
  }

  async reorderProducts(restaurantId: string, orderedIds: string[]) {
    const owned = await this.prisma.product.count({
      where: { id: { in: orderedIds }, restaurantId },
    });
    if (owned !== orderedIds.length) {
      throw new BadRequestException('One or more products do not belong to this restaurant');
    }
    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.product.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
    await this.invalidate(restaurantId);
  }

  // --- Public storefront menu ------------------------------------------------

  /**
   * The customer-facing menu: active categories, available products only.
   * Cached in Redis — this is the single hottest read in the system and the menu
   * changes maybe twice a day. Every mutation above calls invalidate().
   */
  async getPublicMenu(restaurantId: string) {
    const cacheKey = `menu:${restaurantId}`;
    const cached = await this.redis.get<MenuCategoryRow[]>(cacheKey);
    const menu = cached ?? (await this.fetchAndCacheMenu(restaurantId, cacheKey));

    // Never cached alongside the menu -- a promotion toggled on/off must show
    // up on the next request, not wait out a 2-minute menu TTL.
    const promotions = await this.promotions.getActivePromotionsForMenu(restaurantId);
    return withPromoBadges(menu, promotions);
  }

  private async fetchAndCacheMenu(restaurantId: string, cacheKey: string): Promise<MenuCategoryRow[]> {
    const categories = await this.prisma.category.findMany({
      where: { restaurantId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        products: {
          where: { isAvailable: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            description: true,
            priceCents: true,
            imageUrl: true,
            modifierGroups: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                name: true,
                selectionType: true,
                required: true,
                minSelections: true,
                maxSelections: true,
                modifiers: {
                  where: { isAvailable: true },
                  orderBy: { sortOrder: 'asc' },
                  select: { id: true, name: true, priceCents: true },
                },
              },
            },
          },
        },
      },
    });

    // Drop categories that ended up empty — an empty "Desserts" heading on the
    // storefront just looks broken.
    const menu = categories.filter((c) => c.products.length > 0);

    await this.redis.set(cacheKey, menu, MENU_CACHE_TTL_SECONDS);
    return menu;
  }

  private async invalidate(restaurantId: string): Promise<void> {
    await this.redis.del(`menu:${restaurantId}`);
  }
}
