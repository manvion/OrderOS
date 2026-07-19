import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CategoryInput, ProductInput } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import {
  assertRestaurantCapability,
  assertRestaurantWithinLimit,
} from '../../common/plan/plan.util';
import { StorageService } from '../storage/storage.service';
import { PromotionsService, type ActivePromotionForMenu } from '../promotions/promotions.service';
import { MenuImportService } from './menu-import.service';

const MENU_CACHE_TTL_SECONDS = 120;

/** How many strings to translate per AI call — enough to be fast, small enough that
 *  a free model reliably returns a correctly-sized array. */
const TRANSLATE_BATCH = 12;

/** Split an array into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface MenuProductRow {
  id: string;
  name: string;
  nameFr: string | null;
  description: string | null;
  descriptionFr: string | null;
  priceCents: number;
  imageUrl: string | null;
  modifierGroups: unknown[];
}

export interface MenuCategoryRow {
  id: string;
  name: string;
  nameFr: string | null;
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
  private readonly logger = new Logger(MenuService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly promotions: PromotionsService,
    // Auto-translates menu content to French for a BOTH-language storefront.
    private readonly menuImport: MenuImportService,
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
    void this.translateCategory(restaurantId, category.id);
    return category;
  }

  async updateCategory(restaurantId: string, id: string, input: Partial<CategoryInput>) {
    // The compound where is the tenant check: updating a category that belongs to
    // another restaurant matches zero rows and 404s rather than succeeding.
    const existing = await this.prisma.category.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new NotFoundException('Category not found');

    const category = await this.prisma.category.update({ where: { id }, data: input });
    await this.invalidate(restaurantId);
    if (input.name !== undefined) void this.translateCategory(restaurantId, id);
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

    // The free tier caps the menu size — enforced on the way in so an owner is
    // stopped at the 41st item, not silently sold a plan they've already outgrown.
    const productCount = await this.prisma.product.count({ where: { restaurantId } });
    await assertRestaurantWithinLimit(
      this.prisma,
      restaurantId,
      'maxMenuItems',
      productCount,
      'menu items',
    );

    // Stock tracking is a paid capability. Only refuse when they're turning it ON.
    if (input.trackInventory) {
      await assertRestaurantCapability(this.prisma, restaurantId, 'INVENTORY');
    }

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
    void this.translateProduct(restaurantId, product.id);
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

    // Enabling stock tracking on an existing product is gated too, not just at create.
    if (input.trackInventory && !existing.trackInventory) {
      await assertRestaurantCapability(this.prisma, restaurantId, 'INVENTORY');
    }

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
    void this.translateProduct(restaurantId, id);
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
        nameFr: true,
        description: true,
        products: {
          where: { isAvailable: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            nameFr: true,
            description: true,
            descriptionFr: true,
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

  // --- Auto-translation (bilingual BOTH storefront) -------------------------
  //
  // Fire-and-forget: never block a save on an AI call. Only fills French fields
  // that are EMPTY — an item that already has a French version (auto or hand-typed)
  // is left alone, so nothing gets re-translated or overwritten. A translation
  // identical to the source (a proper noun like "Poutine") is not stored — the
  // storefront falls back to the original, which is the same text.

  /** Does this restaurant want the French auto-fill at all? Only BOTH does. */
  private async wantsFrench(restaurantId: string): Promise<boolean> {
    try {
      const r = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { menuLanguage: true },
      });
      return r?.menuLanguage === 'BOTH';
    } catch {
      return false;
    }
  }

  private async translateProduct(restaurantId: string, id: string): Promise<void> {
    try {
      if (!(await this.wantsFrench(restaurantId))) return;
      const p = await this.prisma.product.findUnique({
        where: { id },
        select: { name: true, nameFr: true, description: true, descriptionFr: true },
      });
      if (!p) return;

      const data: { nameFr?: string; descriptionFr?: string } = {};
      if (!p.nameFr) {
        const fr = await this.menuImport.translateToFrench(p.name);
        if (fr && fr !== p.name) data.nameFr = fr;
      }
      if (p.description && !p.descriptionFr) {
        const fr = await this.menuImport.translateToFrench(p.description);
        if (fr && fr !== p.description) data.descriptionFr = fr;
      }

      if (Object.keys(data).length > 0) {
        await this.prisma.product.update({ where: { id }, data });
        await this.invalidate(restaurantId);
      }
    } catch (err) {
      this.logger.warn(`Product translation failed for ${id}: ${(err as Error).message}`);
    }
  }

  private async translateCategory(restaurantId: string, id: string): Promise<void> {
    try {
      if (!(await this.wantsFrench(restaurantId))) return;
      const c = await this.prisma.category.findUnique({
        where: { id },
        select: { name: true, nameFr: true },
      });
      if (!c || c.nameFr) return;
      const fr = await this.menuImport.translateToFrench(c.name);
      if (fr && fr !== c.name) {
        await this.prisma.category.update({ where: { id }, data: { nameFr: fr } });
        await this.invalidate(restaurantId);
      }
    } catch (err) {
      this.logger.warn(`Category translation failed for ${id}: ${(err as Error).message}`);
    }
  }

  /**
   * Translate the WHOLE menu — every item/category still missing its French. Used by
   * the "Translate menu to French" button and when a restaurant switches to BOTH.
   * Sequential on purpose: a burst of parallel AI calls trips rate limits, and this
   * runs in the background where a few extra seconds cost nothing.
   */
  async translateMenuToFrench(restaurantId: string): Promise<{ translated: number }> {
    let translated = 0;

    // Category names.
    const categories = await this.prisma.category.findMany({
      where: { restaurantId, nameFr: null },
      select: { id: true, name: true },
    });
    for (const batch of chunk(categories, TRANSLATE_BATCH)) {
      const frs = await this.menuImport.translateManyToFrench(batch.map((c) => c.name));
      await Promise.all(
        batch.map((c, i) =>
          frs[i]
            ? this.prisma.category
                .update({ where: { id: c.id }, data: { nameFr: frs[i] } })
                .then(() => {
                  translated++;
                })
            : Promise.resolve(),
        ),
      );
    }

    // Product names.
    const nameless = await this.prisma.product.findMany({
      where: { restaurantId, nameFr: null },
      select: { id: true, name: true },
    });
    for (const batch of chunk(nameless, TRANSLATE_BATCH)) {
      const frs = await this.menuImport.translateManyToFrench(batch.map((p) => p.name));
      await Promise.all(
        batch.map((p, i) =>
          frs[i]
            ? this.prisma.product
                .update({ where: { id: p.id }, data: { nameFr: frs[i] } })
                .then(() => {
                  translated++;
                })
            : Promise.resolve(),
        ),
      );
    }

    // Product descriptions (only those that have one and no French yet).
    const descless = await this.prisma.product.findMany({
      where: { restaurantId, description: { not: null }, descriptionFr: null },
      select: { id: true, description: true },
    });
    for (const batch of chunk(descless, TRANSLATE_BATCH)) {
      const frs = await this.menuImport.translateManyToFrench(batch.map((p) => p.description ?? ''));
      await Promise.all(
        batch.map((p, i) =>
          frs[i]
            ? this.prisma.product
                .update({ where: { id: p.id }, data: { descriptionFr: frs[i] } })
                .then(() => {
                  translated++;
                })
            : Promise.resolve(),
        ),
      );
    }

    if (translated > 0) await this.invalidate(restaurantId);
    this.logger.log(`Translated ${translated} menu strings to French for ${restaurantId}`);
    return { translated };
  }

  private async invalidate(restaurantId: string): Promise<void> {
    await this.redis.del(`menu:${restaurantId}`);
  }
}
