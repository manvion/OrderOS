import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_BUSINESS_HOURS,
  isOpenAt,
  totalTaxBps,
  type BusinessHours,
  type CreateRestaurantInput,
  type DeliverySettingsInput,
  type UpdateRestaurantInput,
} from '@orderos/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { ClerkService } from '../../common/auth/clerk.service';
import { AuditService } from '../../common/audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { QrService } from '../qr/qr.service';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class RestaurantsService {
  private readonly logger = new Logger(RestaurantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clerk: ClerkService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
    // Publishing mints the restaurant's starter QR codes, so they have working
    // ones on day one instead of an empty screen they'll never come back to.
    private readonly qr: QrService,
    // Publishing registers the storefront's domain for Apple Pay.
    @Inject(forwardRef(() => PaymentsService))
    private readonly payments: PaymentsService,
  ) {}

  /**
   * Step 1 of onboarding. Creates the tenant AND the OWNER membership for the
   * Clerk user in one transaction — a restaurant without an owner would be
   * unreachable, so the two rows must land together or not at all.
   */
  async create(clerkUserId: string, input: CreateRestaurantInput) {
    const existing = await this.prisma.restaurant.findUnique({ where: { slug: input.slug } });
    if (existing) throw new ConflictException(`The address "${input.slug}" is already taken`);

    const email = (await this.clerk.getPrimaryEmail(clerkUserId)) ?? input.email;
    const clerkUser = await this.clerk.getUser(clerkUserId);

    const restaurant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.restaurant.create({
        data: {
          name: input.name,
          slug: input.slug,
          email: input.email,
          phone: input.phone,
          street: input.address.street,
          city: input.address.city,
          state: input.address.state,
          postalCode: input.address.postalCode,
          country: input.address.country,
          latitude: input.address.latitude,
          longitude: input.address.longitude,
          timezone: input.timezone,
          currency: input.currency,
          description: input.description,

          // The signup wizard asks for all of these. We fall back to a default only
          // for callers that legitimately can't supply them (the admin's
          // create-on-behalf flow, the seed) — never as a way of not asking.
          businessHours: (input.businessHours ??
            DEFAULT_BUSINESS_HOURS) as unknown as object,

          ...(input.pickupEnabled !== undefined ? { pickupEnabled: input.pickupEnabled } : {}),
          ...(input.deliveryEnabled !== undefined
            ? { deliveryEnabled: input.deliveryEnabled }
            : {}),
          ...(input.dineInEnabled !== undefined ? { dineInEnabled: input.dineInEnabled } : {}),
          // Components are authoritative; taxRateBps is stored as their SUM so the
          // dashboard can show "13% tax" at a glance without re-deriving it.
          ...(input.taxComponents
            ? {
                taxComponents: input.taxComponents as unknown as Prisma.InputJsonValue,
                taxRateBps: totalTaxBps(input.taxComponents),
              }
            : input.taxRateBps !== undefined
              ? { taxRateBps: input.taxRateBps }
              : {}),
          ...(input.taxCountry ? { taxCountry: input.taxCountry } : {}),
          ...(input.taxRegion ? { taxRegion: input.taxRegion } : {}),
          ...(input.deliveryFeeCents !== undefined
            ? { deliveryFeeCents: input.deliveryFeeCents }
            : {}),
          ...(input.serviceFeeCents !== undefined
            ? { serviceFeeCents: input.serviceFeeCents }
            : {}),
          ...(input.minOrderCents !== undefined ? { minOrderCents: input.minOrderCents } : {}),
          ...(input.prepTimeMinutes !== undefined
            ? { prepTimeMinutes: input.prepTimeMinutes }
            : {}),

          platformFeeBps: this.config.get<number>('PLATFORM_FEE_BPS') ?? 0,
          onboardingStep: 'BUSINESS_DETAILS',
        },
      });

      await tx.user.create({
        data: {
          clerkUserId,
          email,
          firstName: clerkUser.firstName,
          lastName: clerkUser.lastName,
          imageUrl: clerkUser.imageUrl,
          role: 'OWNER',
          restaurantId: created.id,
        },
      });

      return created;
    });

    await this.audit.log({
      restaurantId: restaurant.id,
      action: 'restaurant.created',
      entityType: 'Restaurant',
      entityId: restaurant.id,
      metadata: { slug: restaurant.slug, name: restaurant.name },
    });

    return restaurant;
  }

  /** Restaurants this Clerk user is staff at. Drives the dashboard's tenant switcher. */
  async listForUser(clerkUserId: string) {
    const memberships = await this.prisma.user.findMany({
      where: { clerkUserId, isActive: true },
      include: { restaurant: true },
      orderBy: { createdAt: 'asc' },
    });
    return memberships
      .filter((m) => m.restaurant.isActive)
      .map((m) => ({ ...m.restaurant, role: m.role }));
  }

  async findById(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    return restaurant;
  }

  /** The storefront payload: public fields only, plus a computed open/closed flag. */
  async findPublicBySlug(slug: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { slug, isPublished: true, isActive: true },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        phone: true,
        street: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        latitude: true,
        longitude: true,
        timezone: true,
        currency: true,
        logoUrl: true,
        coverImageUrl: true,
        brandPrimaryColor: true,
        brandAccentColor: true,
        businessHours: true,
        // The storefront needs this to know whether it is a WEBSITE or an ordering
        // terminal reached by scanning a code — see the OrderingMode enum.
        orderingMode: true,
        pickupEnabled: true,
        deliveryEnabled: true,
        dineInEnabled: true,
        scheduledOrdersEnabled: true,
        deliveryFeeCents: true,
        minOrderCents: true,
        serviceFeeCents: true,
        taxRateBps: true,
        prepTimeMinutes: true,
        // Deliberately NOT selected: stripeAccountId, platformFeeBps, email,
        // onboardingStep. None of that is the customer's business.
      },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const hours = restaurant.businessHours as unknown as BusinessHours;
    return {
      ...restaurant,
      isOpen: isOpenAt(hours, restaurant.timezone),
      /** Can this restaurant actually take money right now? */
      acceptingOrders: isOpenAt(hours, restaurant.timezone),
    };
  }

  async update(restaurantId: string, input: UpdateRestaurantInput, userId?: string) {
    const { address, businessHours, ...rest } = input;

    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        ...rest,
        ...(address
          ? {
              street: address.street,
              city: address.city,
              state: address.state,
              postalCode: address.postalCode,
              country: address.country,
              latitude: address.latitude,
              longitude: address.longitude,
            }
          : {}),
        ...(businessHours ? { businessHours: businessHours as unknown as object } : {}),
      },
    });

    await this.invalidateCache(restaurant.slug);
    await this.audit.log({
      restaurantId,
      userId,
      action: 'restaurant.updated',
      entityType: 'Restaurant',
      entityId: restaurantId,
      metadata: { fields: Object.keys(input) },
    });

    return restaurant;
  }

  async updateDeliverySettings(
    restaurantId: string,
    input: DeliverySettingsInput,
    userId?: string,
  ) {
    if (!input.pickupEnabled && !input.deliveryEnabled && !input.dineInEnabled) {
      throw new BadRequestException(
        'At least one fulfillment method must be enabled, or customers cannot order at all',
      );
    }

    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: {
        ...input,
        onboardingStep: 'DELIVERY',
      },
    });

    await this.invalidateCache(restaurant.slug);
    await this.audit.log({
      restaurantId,
      userId,
      action: 'restaurant.delivery_settings_updated',
      entityType: 'Restaurant',
      entityId: restaurantId,
      metadata: { ...input },
    });

    return restaurant;
  }

  async uploadLogo(restaurantId: string, file: Express.Multer.File, userId?: string) {
    const { url } = await this.storage.upload(
      file.buffer,
      file.mimetype,
      `restaurants/${restaurantId}/logo`,
    );
    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { logoUrl: url, onboardingStep: 'BRANDING' },
    });
    await this.invalidateCache(restaurant.slug);
    return { logoUrl: url };
  }

  async uploadCover(restaurantId: string, file: Express.Multer.File) {
    const { url } = await this.storage.upload(
      file.buffer,
      file.mimetype,
      `restaurants/${restaurantId}/cover`,
    );
    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { coverImageUrl: url },
    });
    await this.invalidateCache(restaurant.slug);
    return { coverImageUrl: url };
  }

  /**
   * The gate at the end of onboarding. We refuse to publish a restaurant that
   * would take an order it cannot fulfil — no menu, or no way to get paid. The
   * blockers are returned as a list so the UI can show a checklist rather than a
   * single unhelpful error.
   */
  async getPublishReadiness(restaurantId: string) {
    const restaurant = await this.findById(restaurantId);
    const [productCount, categoryCount, qrCount] = await Promise.all([
      this.prisma.product.count({ where: { restaurantId, isAvailable: true } }),
      this.prisma.category.count({ where: { restaurantId, isActive: true } }),
      this.prisma.qRCode.count({ where: { restaurantId, isActive: true } }),
    ]);

    const blockers: string[] = [];
    if (categoryCount === 0) blockers.push('Add at least one menu category');
    if (productCount === 0) blockers.push('Add at least one available product');
    if (!restaurant.stripeChargesEnabled) {
      blockers.push('Connect Stripe so you can accept payments');
    }
    if (!restaurant.pickupEnabled && !restaurant.deliveryEnabled && !restaurant.dineInEnabled) {
      blockers.push('Enable at least one fulfillment method');
    }

    /**
     * A QR-only restaurant has no website — the code IS the front door. Publishing
     * one with no codes printed gives customers literally no way to order, and it
     * would look to the owner like the product simply doesn't work.
     */
    if (restaurant.orderingMode === 'QR_ONLY' && qrCount === 0) {
      blockers.push('Generate at least one QR code — it is the only way in without a website');
    }

    const warnings: string[] = [];
    if (!restaurant.logoUrl) warnings.push('Add a logo — your page will look unfinished without one');
    if (restaurant.taxRateBps === 0) warnings.push('Tax rate is 0% — confirm this is correct');

    return {
      ready: blockers.length === 0,
      blockers,
      warnings,
      isPublished: restaurant.isPublished,
      storefrontUrl: this.storefrontUrl(restaurant.slug),
    };
  }

  async publish(restaurantId: string, userId?: string) {
    const readiness = await this.getPublishReadiness(restaurantId);
    if (!readiness.ready) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'NotReadyToPublish',
        message: 'Resolve these before publishing',
        blockers: readiness.blockers,
      });
    }

    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isPublished: true, publishedAt: new Date(), onboardingStep: 'PUBLISHED' },
    });

    await this.invalidateCache(restaurant.slug);
    await this.audit.log({
      restaurantId,
      userId,
      action: 'restaurant.published',
      entityType: 'Restaurant',
      entityId: restaurantId,
    });

    /**
     * Give them working QR codes on the day they go live.
     *
     * Nobody sets up QR ordering by staring at an empty screen and choosing
     * between "counter", "flyer" and "table" — they don't yet know what those
     * mean. A counter code and a flyer code that already work, waiting for them
     * the moment they publish, is the difference between the feature being adopted
     * and being ignored.
     *
     * Fire-and-forget: a QR code is not worth failing a publish over.
     */
    /**
     * Register the storefront domain with Stripe so APPLE PAY works on it.
     *
     * Every restaurant is its own domain, and each must be registered separately.
     * Skip it and Apple Pay never renders — with no error, anywhere.
     */
    const domain = new URL(this.storefrontUrl(restaurant.slug)).hostname;
    void this.payments.registerApplePayDomain(domain).catch(() => {});

    void this.qr.ensureStarterCodes(restaurantId).catch((err) => {
      this.logger.warn(`Starter QR codes failed for ${restaurant.slug}: ${err.message}`);
    });

    this.logger.log(`Restaurant published: ${restaurant.slug}`);
    return { ...restaurant, storefrontUrl: this.storefrontUrl(restaurant.slug) };
  }

  async unpublish(restaurantId: string, userId?: string) {
    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isPublished: false },
    });
    await this.invalidateCache(restaurant.slug);
    await this.audit.log({
      restaurantId,
      userId,
      action: 'restaurant.unpublished',
      entityType: 'Restaurant',
      entityId: restaurantId,
    });
    return restaurant;
  }

  async isSlugAvailable(slug: string): Promise<boolean> {
    const existing = await this.prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true },
    });
    return !existing;
  }

  // --- Staff management -----------------------------------------------------

  async listStaff(restaurantId: string) {
    return this.prisma.user.findMany({
      where: { restaurantId },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        imageUrl: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });
  }

  /**
   * Change a staff member's role. Two invariants:
   *  - You cannot change your own role (no self-promotion, no self-demotion
   *    locking yourself out).
   *  - The last active OWNER cannot be demoted, or the restaurant becomes
   *    permanently unadministrable.
   */
  async updateStaffRole(
    restaurantId: string,
    targetUserId: string,
    role: 'OWNER' | 'MANAGER' | 'STAFF',
    actingUserId: string,
  ) {
    if (targetUserId === actingUserId) {
      throw new ForbiddenException('You cannot change your own role');
    }

    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, restaurantId },
    });
    if (!target) throw new NotFoundException('Staff member not found');

    if (target.role === 'OWNER' && role !== 'OWNER') {
      const owners = await this.prisma.user.count({
        where: { restaurantId, role: 'OWNER', isActive: true },
      });
      if (owners <= 1) {
        throw new BadRequestException(
          'This is the only owner — promote someone else to owner first',
        );
      }
    }

    const updated = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { role },
    });

    await this.audit.log({
      restaurantId,
      userId: actingUserId,
      action: 'staff.role_changed',
      entityType: 'User',
      entityId: targetUserId,
      metadata: { from: target.role, to: role },
    });

    return updated;
  }

  async removeStaff(restaurantId: string, targetUserId: string, actingUserId: string) {
    if (targetUserId === actingUserId) {
      throw new ForbiddenException('You cannot remove yourself');
    }
    const target = await this.prisma.user.findFirst({ where: { id: targetUserId, restaurantId } });
    if (!target) throw new NotFoundException('Staff member not found');

    if (target.role === 'OWNER') {
      const owners = await this.prisma.user.count({
        where: { restaurantId, role: 'OWNER', isActive: true },
      });
      if (owners <= 1) throw new BadRequestException('Cannot remove the only owner');
    }

    // Soft-delete: audit logs reference this user, and we want the history to
    // keep resolving to a name after they leave.
    await this.prisma.user.update({ where: { id: targetUserId }, data: { isActive: false } });

    await this.audit.log({
      restaurantId,
      userId: actingUserId,
      action: 'staff.removed',
      entityType: 'User',
      entityId: targetUserId,
    });
  }

  private storefrontUrl(slug: string): string {
    const domain = this.config.getOrThrow<string>('APP_DOMAIN');
    const isProd = this.config.get('NODE_ENV') === 'production';
    return isProd ? `https://${slug}.${domain}` : `http://${slug}.localhost:3000`;
  }

  private async invalidateCache(slug: string): Promise<void> {
    await this.redis.del(`tenant:slug:${slug}`, `storefront:${slug}`);
    await this.redis.delByPattern(`menu:${slug}:*`);
  }
}
