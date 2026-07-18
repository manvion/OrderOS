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
import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_BUSINESS_HOURS,
  GALLERY_MAX_IMAGES,
  buildSetupChecklist,
  deriveLocaleDefaults,
  getCountry,
  isOpenAt,
  isValidTaxId,
  planAllows,
  publishBlockers,
  setupProgress,
  totalTaxBps,
  type BusinessHours,
  type PlanTier,
  type CreateRestaurantInput,
  type DeliverySettingsInput,
  type SetupStep,
  type UpdateRestaurantInput,
} from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  assertPlanCapability,
  assertRestaurantCapability,
  isMissingPlanColumn,
  PLAN_DB_COLUMNS,
} from '../../common/plan/plan.util';
import { storefrontBaseUrl } from '../../common/tenant-url';
import { RedisService } from '../../common/redis/redis.service';
import { ClerkService } from '../../common/auth/clerk.service';
import { AuditService } from '../../common/audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { QrService } from '../qr/qr.service';
import { PaymentsService } from '../payments/payments.service';
import { VercelClient } from '../domains/vercel.client';

/** How long a new restaurant gets the Starter tier free before it must subscribe. */
const TRIAL_DAYS = 14;

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
    // Publishing also registers the storefront's own subdomain with Vercel so it
    // gets an HTTPS certificate (the wildcard DNS points it at Vercel, but Vercel
    // only serves + certifies hostnames it knows about).
    private readonly vercel: VercelClient,
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

          // Starter is a paid tier, so a new signup opens on a 14-day free trial of
          // it (no card required). The billing banner counts this down and nudges
          // them to subscribe before it lapses. Admin create-on-behalf overwrites
          // this straight away via adminSetPlan when a plan is assigned.
          planTier: 'STARTER',
          subscriptionStatus: 'TRIALING',
          planCurrentPeriodEnd: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000),
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

  /**
   * Restaurants this Clerk user is staff at. Drives the dashboard's tenant switcher
   * and is what the whole dashboard boots from.
   *
   * Wrapped so a not-yet-migrated database can't take every dashboard down: if the
   * plan columns are missing, we retry omitting them rather than 500 (which the
   * dashboard reads as "you have no restaurants" and redirects to onboarding).
   */
  async listForUser(clerkUserId: string) {
    try {
      return await this.loadUserRestaurants(clerkUserId, false);
    } catch (err) {
      if (!isMissingPlanColumn(err)) throw err;
      this.logger.error(
        'Restaurant plan columns are missing — run `npx prisma migrate deploy`. ' +
          'Loading dashboards without plan fields until then.',
      );
      return this.loadUserRestaurants(clerkUserId, true);
    }
  }

  private async loadUserRestaurants(clerkUserId: string, omitPlan: boolean) {
    const memberships = await this.prisma.user.findMany({
      where: { clerkUserId, isActive: true },
      include: { restaurant: omitPlan ? { omit: PLAN_DB_COLUMNS } : true },
      orderBy: { createdAt: 'asc' },
    });

    const own = memberships
      .filter((m) => m.restaurant.isActive)
      .map((m) => ({ ...m.restaurant, role: m.role }));

    /**
     * A platform admin with an ACTIVE support session is, for the next hour, staff
     * of that restaurant — that is the entire point of the session. This list is
     * what the dashboard boots from, and before support sessions were included
     * here, an admin who opened one landed on a dashboard with zero memberships…
     * which helpfully redirected them to onboarding to create their first
     * restaurant. The support tool teleported the supporter into signup.
     *
     * OWNER, because support exists to fix what the owner cannot; a session that
     * can look but not touch is a screen-share, not a support tool. The access is
     * already time-boxed, reason-stamped, and on the restaurant's audit log.
     */
    const admin = await this.prisma.platformAdmin.findUnique({ where: { clerkUserId } });
    if (!admin) return own;

    const sessions = await this.prisma.supportSession.findMany({
      where: { adminId: admin.id, endedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (sessions.length === 0) return own;

    const restaurants = await this.prisma.restaurant.findMany({
      where: { id: { in: sessions.map((s) => s.restaurantId) }, isActive: true },
      ...(omitPlan ? { omit: PLAN_DB_COLUMNS } : {}),
    });

    const alreadyStaff = new Set(own.map((r) => r.id));
    return [
      ...own,
      ...restaurants
        .filter((r) => !alreadyStaff.has(r.id))
        .map((r) => ({ ...r, role: 'OWNER' as const, supportSession: true })),
    ];
  }

  async findById(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException('Restaurant not found');
    return restaurant;
  }

  /**
   * The storefront payload: public fields only, plus a computed open/closed flag.
   *
   * `preview` loosens ONLY the published filter, and only PublicTenantGuard may set
   * it — after validating a staff-minted token. The field list is identical either
   * way; a preview shows the owner exactly what a customer will see, nothing more.
   */
  async findPublicBySlug(slug: string, opts: { preview?: boolean } = {}) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: opts.preview
        ? { slug, isActive: true }
        : { slug, isPublished: true, isActive: true },
      select: {
        id: true,
        slug: true,
        name: true,
        // For the preview banner: a staff preview of a LIVE page shouldn't claim
        // the page isn't live. Harmless to expose — the page being served at all
        // already reveals it (except under preview, where the viewer is staff).
        isPublished: true,
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
        websiteTemplate: true,
        themeMode: true,
        logoDisplayMode: true,
        logoScale: true,
        logoBackdrop: true,
        menuLanguage: true,

        // The About page, in their words. Plain text — the storefront renders it as
        // escaped paragraphs and never as HTML.
        aboutHeadline: true,
        aboutBody: true,
        galleryImages: {
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, url: true, caption: true, sortOrder: true },
        },

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
        loyaltyEnabled: true,
        loyaltyPointsPerDollar: true,
        // Deliberately NOT selected: stripeAccountId, platformFeeBps, email,
        // onboardingStep. None of that is the customer's business.
      },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    /**
     * The PLAN is the source of truth for what the storefront offers, not the old
     * on/off flags. A restaurant that ticked "delivery" or "loyalty" before it was on
     * a plan that includes them must not still show delivery to customers — so the
     * effective flag is (their setting AND their plan grants it).
     *
     * Fetched in its own tiny, independently-resilient query so a not-yet-migrated
     * database can never 500 the customer storefront: a missing column defaults the
     * tier to PRO, i.e. don't gate — fail OPEN, exactly as before plans existed.
     */
    let tier: PlanTier = 'PRO';
    try {
      const p = await this.prisma.restaurant.findUnique({
        where: { id: restaurant.id },
        select: { planTier: true },
      });
      if (p) tier = p.planTier;
    } catch (err) {
      if (!isMissingPlanColumn(err)) throw err;
    }

    const hours = restaurant.businessHours as unknown as BusinessHours;
    return {
      ...restaurant,
      deliveryEnabled: restaurant.deliveryEnabled && planAllows(tier, 'DELIVERY'),
      loyaltyEnabled: restaurant.loyaltyEnabled && planAllows(tier, 'LOYALTY'),
      // Pro removes the platform footer, so the storefront is entirely the
      // restaurant's own brand. Derived here, never a stored flag, so it can't drift
      // from the plan.
      removeBranding: planAllows(tier, 'REMOVE_BRANDING'),
      // Whether to show the "Catering & Parties" entry. Capability-derived; the
      // catering page itself always has the custom-quote form, plus any packages.
      cateringEnabled: planAllows(tier, 'CATERING'),
      isOpen: isOpenAt(hours, restaurant.timezone),
      /** Can this restaurant actually take money right now? */
      acceptingOrders: isOpenAt(hours, restaurant.timezone),
    };
  }

  async update(restaurantId: string, input: UpdateRestaurantInput, userId?: string) {
    const { address, businessHours, taxComponents, ...rest } = input;

    const current = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { country: true, state: true, planTier: true },
    });

    /**
     * Turning a plan-gated feature ON is a settings write like any other, so this is
     * where those gates live. We only refuse the ENABLE — an owner who downgrades can
     * still turn a feature off, and a request that doesn't touch the flag is untouched.
     */
    if (rest.loyaltyEnabled === true) assertPlanCapability(current, 'LOYALTY');

    /** Whichever country this update LANDS on: the new one if the address is changing. */
    const country = address?.country ?? current.country;
    const region = address?.state ?? current.state;

    /**
     * A tax number goes on every receipt this restaurant will ever send. A typo here
     * is not a bad form field — it is a year of invalid invoices discovered at audit,
     * so it is worth rejecting now rather than at audit.
     */
    if (input.taxId?.trim() && !isValidTaxId(country, input.taxId)) {
      const spec = getCountry(country).taxId;
      throw new BadRequestException(
        `That does not look like a valid ${spec.label} — expected something like ${spec.placeholder}`,
      );
    }

    /**
     * Move the restaurant, and its currency, timezone and tax move with it.
     *
     * These three are consequences of the address, not independent settings — see
     * deriveLocaleDefaults(). Before this, they were schema defaults (USD,
     * America/New_York, 0%) that no code path ever updated, so a restaurant in
     * Bengaluru was priced in dollars and kept New York hours.
     *
     * Derived values NEVER overwrite an explicit one in the same request: if the owner
     * is correcting their tax rate, the correction wins. Currency is the exception —
     * the schema does not accept it at all, because it is not a choice.
     */
    const relocated = address !== undefined &&
      (address.country !== current.country || address.state !== current.state);

    const derived = relocated ? deriveLocaleDefaults(country, region) : null;

    /** An explicit component list wins, and its combined rate must follow it. */
    const explicitTax = taxComponents
      ? { taxComponents, taxRateBps: totalTaxBps(taxComponents) }
      : {};

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
        ...(derived
          ? {
              currency: derived.currency,
              // Only if they haven't said otherwise: an owner in a six-timezone country
              // who picked Denver does not want it reset to New York because they fixed
              // a typo in their street.
              ...(rest.timezone ? {} : { timezone: derived.timezone }),
              ...(taxComponents
                ? {}
                : {
                    taxCountry: derived.taxCountry,
                    taxRegion: derived.taxRegion,
                    taxComponents: derived.taxComponents,
                    taxRateBps: derived.taxRateBps,
                  }),
            }
          : {}),
        ...explicitTax,
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

    // Courier delivery is a paid capability. Pickup and dine-in are on every plan
    // (they're the free tier's whole point), so only the delivery toggle is gated.
    if (input.deliveryEnabled) {
      await assertRestaurantCapability(this.prisma, restaurantId, 'DELIVERY');
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

  // --- About page gallery ----------------------------------------------------

  listGallery(restaurantId: string) {
    return this.prisma.galleryImage.findMany({
      where: { restaurantId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, url: true, caption: true, sortOrder: true },
    });
  }

  async addGalleryImage(restaurantId: string, file: Express.Multer.File, caption?: string) {
    const count = await this.prisma.galleryImage.count({ where: { restaurantId } });
    if (count >= GALLERY_MAX_IMAGES) {
      throw new BadRequestException(
        `You can have up to ${GALLERY_MAX_IMAGES} photos. Remove one to add another.`,
      );
    }

    // StorageService validates the MIME type and the 5MB cap and says which rule
    // was broken, so a bad upload fails BEFORE we write a row pointing at nothing.
    const { url, key } = await this.storage.upload(
      file.buffer,
      file.mimetype,
      `restaurants/${restaurantId}/gallery`,
    );

    const image = await this.prisma.galleryImage.create({
      data: {
        restaurantId,
        url,
        storageKey: key,
        caption: caption?.slice(0, 200) || null,
        sortOrder: count,
      },
      select: { id: true, url: true, caption: true, sortOrder: true },
    });

    const restaurant = await this.findById(restaurantId);
    await this.invalidateCache(restaurant.slug);

    return image;
  }

  async removeGalleryImage(restaurantId: string, id: string) {
    // Scoped by restaurantId, not just by id: an id alone would let a manager at one
    // restaurant delete another restaurant's photo.
    const image = await this.prisma.galleryImage.findFirst({ where: { id, restaurantId } });
    if (!image) throw new NotFoundException('Photo not found');

    await this.prisma.galleryImage.delete({ where: { id } });
    // Delete the blob too. A row removed while its file lingers is a bill that grows
    // forever and a photo nobody can see or find.
    await this.storage.delete(image.storageKey);

    const restaurant = await this.findById(restaurantId);
    await this.invalidateCache(restaurant.slug);

    return { success: true };
  }

  /**
   * The gate at the end of onboarding. We refuse to publish a restaurant that
   * would take an order it cannot fulfil — no menu, or no way to get paid. The
   * blockers are returned as a list so the UI can show a checklist rather than a
   * single unhelpful error.
   */
  async getPublishReadiness(restaurantId: string) {
    const restaurant = await this.findById(restaurantId);
    const steps = await this.setupSteps(restaurantId, restaurant);
    const blockers = publishBlockers(steps);

    return {
      ready: blockers.length === 0,
      /** The whole checklist, done and not — the owner needs to see both. */
      steps,
      progress: setupProgress(steps),
      // Kept as strings for older callers. `steps` is the real answer.
      blockers: blockers.map((s) => s.label),
      warnings: steps.filter((s) => !s.required && !s.done).map((s) => s.why),
      isPublished: restaurant.isPublished,
      storefrontUrl: this.storefrontUrl(restaurant.slug),
    };
  }

  /**
   * The one place that answers "what is left to do before this restaurant can take
   * money" — see packages/shared/src/setup.ts for why it lives there and not here.
   * The admin console calls this too, so support sees exactly what the owner sees.
   */
  async setupSteps(
    restaurantId: string,
    loaded?: Awaited<ReturnType<RestaurantsService['findById']>>,
  ): Promise<SetupStep[]> {
    const restaurant = loaded ?? (await this.findById(restaurantId));

    const [availableProductCount, categoryCount, activeQrCount] = await Promise.all([
      this.prisma.product.count({ where: { restaurantId, isAvailable: true } }),
      this.prisma.category.count({ where: { restaurantId, isActive: true } }),
      this.prisma.qRCode.count({ where: { restaurantId, isActive: true } }),
    ]);

    return buildSetupChecklist({
      orderingMode: restaurant.orderingMode,
      categoryCount,
      availableProductCount,
      activeQrCount,
      stripeChargesEnabled: restaurant.stripeChargesEnabled,
      pickupEnabled: restaurant.pickupEnabled,
      deliveryEnabled: restaurant.deliveryEnabled,
      dineInEnabled: restaurant.dineInEnabled,
      hasLogo: Boolean(restaurant.logoUrl),
      taxRateBps: restaurant.taxRateBps,
      isPublished: restaurant.isPublished,
    });
  }

  async publish(restaurantId: string, userId?: string) {
    /**
     * A public ordering WEBSITE is a paid capability — the free Starter tier is a QR
     * ordering system, not a website. So a WEBSITE-mode restaurant can't go live
     * without a plan that includes it; a QR_ONLY restaurant publishes freely, because
     * its "storefront" is just the terminal a scanned code opens. Fails open if the
     * plan columns aren't migrated in yet (assertRestaurantCapability handles that).
     */
    const { orderingMode } = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { orderingMode: true },
    });
    if (orderingMode === 'WEBSITE') {
      await assertRestaurantCapability(this.prisma, restaurantId, 'WEBSITE_STOREFRONT');
    }

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

    // Register the subdomain with Vercel so it is actually served over HTTPS. The
    // wildcard DNS (`*.APP_DOMAIN`) routes every storefront to Vercel, but Vercel
    // only answers — and only mints a certificate — for hostnames on the project.
    void this.registerStorefrontDomain(domain);

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

  /**
   * What a specific person (or everyone) actually did -- accountability, not
   * scheduling. Reads the same AuditLog every mutating endpoint already writes
   * to (see AuditService / the @Audit decorator), so this adds no new writes,
   * just a read the dashboard didn't expose yet.
   */
  async listActivity(restaurantId: string, options: { userId?: string; limit?: number } = {}) {
    return this.prisma.auditLog.findMany({
      where: { restaurantId, ...(options.userId ? { userId: options.userId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: Math.min(options.limit ?? 100, 200),
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        createdAt: true,
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
  }

  private storefrontUrl(slug: string): string {
    return storefrontBaseUrl(this.config, slug);
  }

  /**
   * Attach a storefront's own subdomain to the Vercel project, so Vercel serves it
   * and issues its HTTPS certificate.
   *
   * Best-effort and idempotent (Vercel treats an already-added domain as success),
   * and never worth failing a publish over — hence the fire-and-forget call site.
   * Only fires for a real `<slug>.APP_DOMAIN` subdomain: skipped when Vercel isn't
   * configured (local dev) or when the host isn't under our apex (path-mode tenancy,
   * localhost), where there is nothing for Vercel to certify.
   */
  private async registerStorefrontDomain(domain: string): Promise<void> {
    if (!this.vercel.isConfigured) return;
    const appDomain = this.config.get<string>('APP_DOMAIN');
    if (!appDomain || !domain.endsWith(`.${appDomain}`)) return;

    try {
      await this.vercel.addDomain(domain);
      this.logger.log(`Registered storefront subdomain ${domain} with Vercel`);
    } catch (err) {
      this.logger.warn(`Could not register ${domain} with Vercel: ${(err as Error).message}`);
    }
  }

  /**
   * A 30-minute window in which the owner can see their UNPUBLISHED storefront.
   *
   * The link goes through the storefront's /preview-gate route, which stores the
   * token in a cookie and bounces to the homepage — so the whole site (menu, about)
   * works during the preview, not just one URL. Minting again just moves the
   * expiry; there is one active token per restaurant, and publishing makes the
   * whole mechanism moot.
   */
  async createPreviewLink(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { slug: true },
    });

    const token = randomBytes(16).toString('hex');
    const ttlSeconds = 30 * 60;
    await this.redis.set(`preview:${restaurant.slug}`, token, ttlSeconds);

    return {
      url: `${this.storefrontUrl(restaurant.slug)}/preview-gate?token=${token}`,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  private async invalidateCache(slug: string): Promise<void> {
    await this.redis.del(`tenant:slug:${slug}`, `storefront:${slug}`);
    await this.redis.delByPattern(`menu:${slug}:*`);
  }
}
