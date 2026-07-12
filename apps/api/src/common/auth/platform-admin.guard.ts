import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { PlatformRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClerkService } from './clerk.service';
import type { AuthedRequest } from './request-context';

export interface PlatformAdminUser {
  id: string;
  clerkUserId: string;
  email: string;
  role: PlatformRole;
}

export interface PlatformRequest extends AuthedRequest {
  admin?: PlatformAdminUser;
}

/** Minimum platform role. Absent = any active admin. */
export const PLATFORM_ROLES_KEY = 'platformRoles';
export const PlatformRoles = (...roles: PlatformRole[]) =>
  SetMetadata(PLATFORM_ROLES_KEY, roles);

/**
 * The door to the platform admin.
 *
 * Two things make this safe:
 *
 * 1. It checks a DIFFERENT table (`PlatformAdmin`) than the tenant guard. There is
 *    no role a restaurant owner can be given that turns them into one of us. The
 *    two systems can't be confused because they don't share a row.
 *
 * 2. Bootstrapping is by allow-listed EMAIL in the environment, not by an endpoint.
 *    A "create the first admin" API is a permanent backdoor — it either has to be
 *    disabled after first use (and someone forgets) or it checks "are there zero
 *    admins?" (and someone deletes them all). An env var can only be changed by
 *    someone who already has production access, which is the correct bar.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  private readonly logger = new Logger(PlatformAdminGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PlatformRequest>();

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const claims = await this.clerk.verifySessionToken(header.slice(7));
    if (!claims) throw new UnauthorizedException('Invalid or expired session');

    let admin = await this.prisma.platformAdmin.findUnique({
      where: { clerkUserId: claims.sub },
    });

    // Bootstrap: an allow-listed email becomes an admin on first sign-in.
    if (!admin) {
      admin = await this.bootstrapFromAllowlist(claims.sub);
    }

    if (!admin || !admin.isActive) {
      // Deliberately indistinguishable from "this route doesn't exist" — an
      // attacker probing /api/admin should learn nothing from the response.
      this.logger.warn(`Non-admin attempted platform access: ${claims.sub}`);
      throw new ForbiddenException('Not found');
    }

    const required = this.reflector.getAllAndOverride<PlatformRole[]>(PLATFORM_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // SUPER_ADMIN implies SUPPORT. SUPPORT does not imply SUPER_ADMIN — a support
    // agent can read a restaurant to help them, and cannot change our commission
    // or switch a live business off.
    if (required?.includes('SUPER_ADMIN') && admin.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('This action requires a super admin');
    }

    req.admin = {
      id: admin.id,
      clerkUserId: admin.clerkUserId,
      email: admin.email,
      role: admin.role,
    };

    // Cheap presence signal, so we can see who is actually using the admin.
    void this.prisma.platformAdmin
      .update({ where: { id: admin.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});

    return true;
  }

  /**
   * Promote an allow-listed email to SUPER_ADMIN the first time they sign in.
   *
   * `PLATFORM_ADMIN_EMAILS=you@company.com,cofounder@company.com`
   *
   * The email comes from CLERK, not from the request — so an attacker cannot claim
   * to be you by sending a header. They would have to actually control a Clerk
   * account whose verified primary email is on the list.
   */
  private async bootstrapFromAllowlist(clerkUserId: string) {
    const raw = this.config.get<string>('PLATFORM_ADMIN_EMAILS') ?? '';
    const allowlist = raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    if (allowlist.length === 0) return null;

    const email = (await this.clerk.getPrimaryEmail(clerkUserId))?.toLowerCase();
    if (!email || !allowlist.includes(email)) return null;

    const clerkUser = await this.clerk.getUser(clerkUserId);

    const admin = await this.prisma.platformAdmin.upsert({
      where: { clerkUserId },
      create: {
        clerkUserId,
        email,
        name: [clerkUser.firstName, clerkUser.lastName].filter(Boolean).join(' ') || null,
        role: 'SUPER_ADMIN',
      },
      update: { isActive: true },
    });

    this.logger.warn(`Bootstrapped platform SUPER_ADMIN from allowlist: ${email}`);
    return admin;
  }
}
