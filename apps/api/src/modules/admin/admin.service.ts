import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CreateRestaurantInput } from '@orderos/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { EmailService } from '../notifications/email.service';
import { StaffInvitesService } from '../restaurants/staff-invites.service';
import type { PlatformAdminUser } from '../../common/auth/platform-admin.guard';

/** How long a support session lasts before it expires on its own. */
const SUPPORT_SESSION_MINUTES = 60;

/**
 * Everything the signup wizard asks a restaurant, plus the two things only the
 * platform can set: who owns it, and what we charge them.
 */
export type AdminCreateRestaurantInput = CreateRestaurantInput & {
  ownerEmail: string;
  platformFeeBps?: number;
};

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly invites: StaffInvitesService,
  ) {}

  // --- The platform at a glance ---------------------------------------------

  /**
   * The numbers you'd actually look at on a Monday.
   *
   * GMV is gross merchandise value — what customers paid across every restaurant —
   * NOT our revenue. Our revenue is the platform fee on top. Conflating the two is
   * how a marketplace convinces itself it's ten times bigger than it is, so both
   * are reported, separately and honestly.
   */
  async getOverview(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const previousSince = new Date(since.getTime() - days * 86_400_000);

    const [
      totalRestaurants,
      liveRestaurants,
      newRestaurants,
      current,
      previous,
      stuckInOnboarding,
    ] = await Promise.all([
      this.prisma.restaurant.count({ where: { isActive: true } }),
      this.prisma.restaurant.count({ where: { isActive: true, isPublished: true } }),
      this.prisma.restaurant.count({ where: { createdAt: { gte: since } } }),
      this.aggregate(since, new Date()),
      this.aggregate(previousSince, since),

      // Signed up, never went live. The single most actionable list on this page:
      // these are people who WANTED the product and got stuck. Every one is a
      // conversation, not a metric.
      this.prisma.restaurant.count({
        where: {
          isActive: true,
          isPublished: false,
          createdAt: { lt: new Date(Date.now() - 3 * 86_400_000) },
        },
      }),
    ]);

    return {
      restaurants: {
        total: totalRestaurants,
        live: liveRestaurants,
        new: newRestaurants,
        stuckInOnboarding,
      },
      /** What customers paid, across all restaurants. Not ours. */
      gmvCents: current.gmvCents,
      /** What WE earned: the platform fee. This is the real number. */
      platformRevenueCents: current.platformFeeCents,
      orders: current.orders,
      refundedCents: current.refundedCents,
      changes: {
        gmv: this.percentChange(current.gmvCents, previous.gmvCents),
        platformRevenue: this.percentChange(current.platformFeeCents, previous.platformFeeCents),
        orders: this.percentChange(current.orders, previous.orders),
      },
    };
  }

  private async aggregate(from: Date, to: Date) {
    const [orders, payments] = await Promise.all([
      this.prisma.order.aggregate({
        where: {
          createdAt: { gte: from, lt: to },
          payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        },
        _sum: { totalCents: true },
        _count: true,
      }),
      this.prisma.payment.aggregate({
        where: {
          createdAt: { gte: from, lt: to },
          status: { in: ['PAID', 'PARTIALLY_REFUNDED'] },
        },
        _sum: { platformFeeCents: true, refundedAmountCents: true },
      }),
    ]);

    return {
      gmvCents: orders._sum.totalCents ?? 0,
      orders: orders._count,
      platformFeeCents: payments._sum.platformFeeCents ?? 0,
      refundedCents: payments._sum.refundedAmountCents ?? 0,
    };
  }

  // --- Restaurants -----------------------------------------------------------

  async listRestaurants(opts: {
    search?: string;
    status?: 'live' | 'draft' | 'suspended';
    limit?: number;
    cursor?: string;
  }) {
    const take = Math.min(opts.limit ?? 50, 100);

    const where: Prisma.RestaurantWhereInput = {
      ...(opts.search
        ? {
            OR: [
              { name: { contains: opts.search, mode: 'insensitive' } },
              { slug: { contains: opts.search, mode: 'insensitive' } },
              { email: { contains: opts.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(opts.status === 'live' ? { isActive: true, isPublished: true } : {}),
      ...(opts.status === 'draft' ? { isActive: true, isPublished: false } : {}),
      ...(opts.status === 'suspended' ? { isActive: false } : {}),
    };

    const restaurants = await this.prisma.restaurant.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
      select: {
        id: true,
        name: true,
        slug: true,
        email: true,
        phone: true,
        city: true,
        orderingMode: true,
        isActive: true,
        isPublished: true,
        onboardingStep: true,
        stripeChargesEnabled: true,
        platformFeeBps: true,
        createdAt: true,
        _count: { select: { orders: true, products: true, users: true } },
      },
    });

    const hasMore = restaurants.length > take;
    return {
      restaurants: hasMore ? restaurants.slice(0, take) : restaurants,
      nextCursor: hasMore ? restaurants[take - 1].id : null,
    };
  }

  /** Everything about one restaurant, including why they might be stuck. */
  async getRestaurant(id: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id },
      include: {
        users: {
          where: { isActive: true },
          select: { id: true, email: true, role: true, firstName: true, lastName: true },
        },
        _count: { select: { orders: true, products: true, categories: true, customers: true } },
      },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const [revenue, lastOrder] = await Promise.all([
      this.prisma.payment.aggregate({
        where: { restaurantId: id, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
        _sum: { amountCents: true, platformFeeCents: true },
      }),
      this.prisma.order.findFirst({
        where: { restaurantId: id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, orderNumber: true },
      }),
    ]);

    // Why aren't they live? The same checks the owner sees — so when they phone us
    // saying "it won't let me publish", we can see exactly what they see.
    const blockers: string[] = [];
    if (restaurant._count.products === 0) blockers.push('No menu items');
    if (!restaurant.stripeChargesEnabled) blockers.push('Stripe not connected');
    if (!restaurant.pickupEnabled && !restaurant.deliveryEnabled && !restaurant.dineInEnabled) {
      blockers.push('No fulfillment method enabled');
    }

    return {
      ...restaurant,
      lifetimeGmvCents: revenue._sum.amountCents ?? 0,
      lifetimePlatformFeeCents: revenue._sum.platformFeeCents ?? 0,
      lastOrderAt: lastOrder?.createdAt ?? null,
      publishBlockers: blockers,
    };
  }

  /**
   * Onboard a restaurant on their behalf.
   *
   * The self-serve flow is the default and always will be, but the first fifty
   * restaurants on any platform are onboarded by a human on a phone call. This is
   * that: we create the tenant and INVITE the owner, who then sets their own
   * password and takes ownership.
   *
   * We deliberately do NOT create their Clerk account for them. An account whose
   * password we chose is an account we can impersonate silently, and "the platform
   * can log in as me without my knowledge" is not a thing a business owner should
   * ever have to accept.
   */
  async createRestaurantForOwner(
    input: AdminCreateRestaurantInput,
    admin: PlatformAdminUser,
  ) {
    const existing = await this.prisma.restaurant.findUnique({ where: { slug: input.slug } });
    if (existing) throw new BadRequestException(`The address "${input.slug}" is already taken`);

    const { DEFAULT_BUSINESS_HOURS, totalTaxBps } = await import('@orderos/shared');

    /**
     * A QR-only restaurant serves people who are standing in the building. Dine-in
     * is therefore on by default, and delivery is meaningless unless someone asks
     * for it — but every one of these is still overridable, because "QR-only" and
     * "takeaway counter with a QR on it" are both real and only the operator knows
     * which one they are.
     */
    const qrOnly = input.orderingMode === 'QR_ONLY';

    const taxComponents = input.taxComponents ?? [];
    const restaurant = await this.prisma.restaurant.create({
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description,
        email: input.email,
        phone: input.phone,
        street: input.address.street,
        city: input.address.city,
        state: input.address.state,
        postalCode: input.address.postalCode,
        country: input.address.country,
        timezone: input.timezone,
        currency: input.currency,

        businessHours: (input.businessHours ?? DEFAULT_BUSINESS_HOURS) as unknown as object,
        orderingMode: qrOnly ? 'QR_ONLY' : 'WEBSITE',

        pickupEnabled: input.pickupEnabled ?? !qrOnly,
        deliveryEnabled: input.deliveryEnabled ?? false,
        dineInEnabled: input.dineInEnabled ?? qrOnly,

        /**
         * Tax is asked, never assumed. `taxRateBps` is the combined rate we keep for
         * display; the components are what actually gets charged and printed, because
         * Quebec must show GST and QST separately and India CGST and SGST.
         */
        taxComponents: taxComponents.length ? (taxComponents as unknown as object) : undefined,
        taxRateBps: taxComponents.length ? totalTaxBps(taxComponents) : (input.taxRateBps ?? 0),
        taxCountry: input.taxCountry,
        taxRegion: input.taxRegion,

        deliveryFeeCents: input.deliveryFeeCents,
        serviceFeeCents: input.serviceFeeCents,
        minOrderCents: input.minOrderCents,
        prepTimeMinutes: input.prepTimeMinutes,

        platformFeeBps: input.platformFeeBps ?? 0,
        onboardingStep: 'BUSINESS_DETAILS',
      },
    });

    // The owner claims it by accepting an invite sent to their own email.
    await this.invites.create(
      restaurant.id,
      { email: input.ownerEmail, role: 'OWNER' },
      // The invite is attributed to the platform, not to a staff member of theirs
      // (there aren't any yet). Passing OWNER lets it mint an OWNER invite.
      { id: 'platform', role: 'OWNER' },
    );

    await this.audit.log({
      restaurantId: restaurant.id,
      action: 'platform.restaurant_created',
      entityType: 'Restaurant',
      entityId: restaurant.id,
      metadata: {
        byAdmin: admin.email,
        ownerEmail: input.ownerEmail,
        platformFeeBps: restaurant.platformFeeBps,
      },
    });

    this.logger.log(
      `Admin ${admin.email} created restaurant ${restaurant.slug} and invited ${input.ownerEmail} as owner`,
    );

    return restaurant;
  }

  /**
   * Set the commission we take on this restaurant's orders.
   *
   * SUPER_ADMIN only, and audited. This is the price of the product, negotiated per
   * restaurant, and it must never be something a support agent can change on a
   * phone call to make an angry customer happy.
   *
   * Note it applies to FUTURE orders only. Existing payments have already had their
   * application fee taken by Stripe; rewriting the rate retroactively would make
   * our books disagree with theirs.
   */
  async setPlatformFee(restaurantId: string, bps: number, admin: PlatformAdminUser) {
    if (bps < 0 || bps > 3000) {
      throw new BadRequestException('Commission must be between 0% and 30%');
    }

    const before = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { platformFeeBps: true, name: true },
    });
    if (!before) throw new NotFoundException('Restaurant not found');

    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { platformFeeBps: bps },
    });

    await this.audit.log({
      restaurantId,
      action: 'platform.fee_changed',
      entityType: 'Restaurant',
      entityId: restaurantId,
      metadata: { byAdmin: admin.email, from: before.platformFeeBps, to: bps },
    });

    this.logger.warn(
      `Admin ${admin.email} changed ${before.name}'s commission: ${before.platformFeeBps / 100}% -> ${bps / 100}%`,
    );

    return restaurant;
  }

  /**
   * Switch a restaurant off, or back on.
   *
   * Suspension is immediate and total: their storefront 404s, the widget stops
   * loading, and no order can be placed. It does NOT delete anything — orders,
   * customers and money all stay exactly where they are, because the usual reason
   * to suspend is a billing dispute, and destroying a business's data over an
   * invoice is not something to make easy.
   */
  async setActive(
    restaurantId: string,
    isActive: boolean,
    reason: string,
    admin: PlatformAdminUser,
  ) {
    const restaurant = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { isActive },
    });

    await this.audit.log({
      restaurantId,
      action: isActive ? 'platform.restaurant_reactivated' : 'platform.restaurant_suspended',
      entityType: 'Restaurant',
      entityId: restaurantId,
      metadata: { byAdmin: admin.email, reason },
    });

    this.logger.warn(
      `Admin ${admin.email} ${isActive ? 'REACTIVATED' : 'SUSPENDED'} ${restaurant.name}: ${reason}`,
    );

    // The tenant lookup is cached by slug; a suspension that takes five minutes to
    // bite is a suspension that didn't work.
    return restaurant;
  }

  // --- Support access --------------------------------------------------------

  /**
   * Open a time-boxed session to act inside a restaurant's dashboard.
   *
   * This is how you help an owner who says "it won't let me publish" — you see
   * exactly what they see. It is also, unavoidably, the ability to read their
   * customers and their revenue. So it is deliberately awkward: it needs a written
   * reason, it expires after an hour, and it is permanently on the restaurant's own
   * audit log, where they can see it.
   *
   * A support tool the customer cannot see them using is a surveillance tool.
   */
  async startSupportSession(
    restaurantId: string,
    reason: string,
    admin: PlatformAdminUser,
  ) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    if (!reason?.trim()) {
      throw new BadRequestException('A reason is required to access a restaurant');
    }

    const session = await this.prisma.supportSession.create({
      data: {
        adminId: admin.id,
        adminEmail: admin.email,
        restaurantId,
        reason: reason.trim(),
        expiresAt: new Date(Date.now() + SUPPORT_SESSION_MINUTES * 60_000),
      },
    });

    // On THEIR audit log, not just ours. They get to see us in their own history.
    await this.audit.log({
      restaurantId,
      action: 'platform.support_session_started',
      entityType: 'Restaurant',
      entityId: restaurantId,
      metadata: { byAdmin: admin.email, reason: session.reason, expiresAt: session.expiresAt },
    });

    this.logger.warn(
      `SUPPORT ACCESS: ${admin.email} opened a session on ${restaurant.name} — "${session.reason}"`,
    );

    return session;
  }

  async endSupportSession(sessionId: string, admin: PlatformAdminUser) {
    const session = await this.prisma.supportSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.adminId !== admin.id && admin.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException("You cannot close someone else's session");
    }

    return this.prisma.supportSession.update({
      where: { id: sessionId },
      data: { endedAt: new Date() },
    });
  }

  /**
   * Does this admin currently hold a live support session for this restaurant?
   * Consulted by ClerkAuthGuard when an admin calls a normal dashboard endpoint.
   */
  async hasActiveSupportSession(adminId: string, restaurantId: string): Promise<boolean> {
    const session = await this.prisma.supportSession.findFirst({
      where: {
        adminId,
        restaurantId,
        endedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return Boolean(session);
  }

  /** Who has been in whose data, and why. The transparency record. */
  async listSupportSessions(restaurantId?: string) {
    return this.prisma.supportSession.findMany({
      where: restaurantId ? { restaurantId } : {},
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  // --- Admins ----------------------------------------------------------------

  async listAdmins() {
    return this.prisma.platformAdmin.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        lastSeenAt: true,
        createdAt: true,
      },
    });
  }

  private percentChange(current: number, previous: number): number | null {
    if (previous === 0) return null;
    return Math.round(((current - previous) / previous) * 100);
  }
}
