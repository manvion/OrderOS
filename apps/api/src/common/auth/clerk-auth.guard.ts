import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLE_RANK, type StaffRole } from '@orderos/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ClerkService } from './clerk.service';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';
import type { AuthedRequest, AuthUser } from './request-context';

/**
 * The single gate for every staff route.
 *
 * 1. Verifies the Clerk session JWT.
 * 2. Loads the caller's User row — the membership that binds a Clerk identity to
 *    exactly one restaurant. No membership, no access.
 * 3. Pins `req.restaurantId` from that membership.
 * 4. Enforces the route's minimum role.
 *
 * Step 3 is the load-bearing one: the tenant is derived from the *server-side*
 * membership record, never from a header, query param or body field the client
 * controls. That is what makes cross-tenant access impossible rather than merely
 * discouraged.
 *
 * A user who belongs to several restaurants has one User row per restaurant and
 * selects which one they're acting as with the `X-Restaurant-Id` header; we still
 * verify that header against their memberships before honouring it.
 */
@Injectable()
export class ClerkAuthGuard implements CanActivate {
  private readonly logger = new Logger(ClerkAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const claims = await this.clerk.verifySessionToken(header.slice(7));
    if (!claims) throw new UnauthorizedException('Invalid or expired session');

    const memberships = await this.prisma.user.findMany({
      where: { clerkUserId: claims.sub, isActive: true },
      include: { restaurant: { select: { id: true, isActive: true } } },
    });
    const active = memberships.filter((m) => m.restaurant.isActive);

    /**
     * A platform admin, with a live support session, acting inside a restaurant's
     * dashboard to help them.
     *
     * This is the ONLY way anyone without a membership can reach tenant data, and
     * it is deliberately narrow:
     *
     *  - they must be an active PlatformAdmin (a separate table — no restaurant
     *    role can grant this);
     *  - they must name the restaurant explicitly via X-Restaurant-Id (no
     *    "browse everyone's data" mode);
     *  - and they must hold an unexpired SupportSession for THAT restaurant, which
     *    required a written reason and is on the restaurant's own audit log.
     *
     * Take any one of those away and this becomes a backdoor. Together they make it
     * a door the customer can see us walk through.
     */
    const requestedId = req.headers['x-restaurant-id'] as string | undefined;

    if (active.length === 0 && requestedId) {
      const supportContext = await this.tryResolveSupportSession(claims.sub, requestedId);
      if (supportContext) {
        req.user = supportContext;
        req.restaurantId = requestedId;
        return true; // role checks below are skipped: support acts with OWNER rights
      }
    }

    if (active.length === 0) {
      // Authenticated with Clerk but not staff anywhere yet. The onboarding
      // endpoint is the only route that tolerates this (it is @Public and
      // resolves the Clerk id itself).
      throw new ForbiddenException('No active restaurant membership for this account');
    }

    const requested = req.headers['x-restaurant-id'] as string | undefined;
    const membership = requested
      ? active.find((m) => m.restaurantId === requested)
      : active[0];

    if (!membership) {
      // They asked to act as a restaurant they aren't a member of. 403, and it
      // is indistinguishable from the restaurant not existing.
      throw new ForbiddenException('You do not have access to this restaurant');
    }

    req.user = {
      id: membership.id,
      clerkUserId: membership.clerkUserId,
      email: membership.email,
      role: membership.role as StaffRole,
      restaurantId: membership.restaurantId,
    };
    req.restaurantId = membership.restaurantId;

    const required = this.reflector.getAllAndOverride<StaffRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required?.length) {
      // Hierarchical: the lowest listed role is the bar to clear.
      const bar = Math.min(...required.map((r) => ROLE_RANK[r]));
      if (ROLE_RANK[req.user.role] < bar) {
        throw new ForbiddenException('Your role does not permit this action');
      }
    }

    return true;
  }

  /**
   * Is this Clerk user a platform admin holding a live support session for this
   * restaurant? Returns an AuthUser standing in for them, or null.
   *
   * Note we do NOT give them a real User row. They are a visitor: the audit log
   * records the action against a null userId with the admin's email in metadata, so
   * a restaurant reading their own history sees "OrderOS support did this", not a
   * phantom staff member they don't recognise.
   */
  private async tryResolveSupportSession(
    clerkUserId: string,
    restaurantId: string,
  ): Promise<AuthUser | null> {
    const admin = await this.prisma.platformAdmin.findUnique({
      where: { clerkUserId },
      select: { id: true, email: true, isActive: true },
    });
    if (!admin?.isActive) return null;

    const session = await this.prisma.supportSession.findFirst({
      where: {
        adminId: admin.id,
        restaurantId,
        endedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!session) return null;

    this.logger.warn(
      `Platform admin ${admin.email} acting on restaurant ${restaurantId} via support session ${session.id}`,
    );

    return {
      // Not a real membership id — nothing may write this to a foreign key.
      id: `support:${admin.id}`,
      clerkUserId,
      email: admin.email,
      // Support acts with owner-level rights, because the whole point is to do the
      // thing the owner cannot work out how to do.
      role: 'OWNER',
      restaurantId,
    };
  }
}
