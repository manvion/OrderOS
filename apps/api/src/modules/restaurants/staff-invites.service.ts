import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StaffRole } from '@orderos/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { ClerkService } from '../../common/auth/clerk.service';
import { EmailService } from '../notifications/email.service';

const INVITE_TTL_DAYS = 7;

/**
 * Staff invitations.
 *
 * Before this existed, the ONLY User row a restaurant could ever have was the
 * person who created it. There was no way to add a manager or a line cook, which
 * made the whole RBAC system decorative.
 *
 * The invite is keyed by EMAIL, not by a Clerk user id, because the person being
 * invited usually doesn't have an account yet — they'll create one when they click
 * the link. The membership row is created at ACCEPT time, once we know who they are.
 */
@Injectable()
export class StaffInvitesService {
  private readonly logger = new Logger(StaffInvitesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly clerk: ClerkService,
    private readonly email: EmailService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async list(restaurantId: string) {
    return this.prisma.staffInvite.findMany({
      where: { restaurantId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
  }

  async create(
    restaurantId: string,
    input: { email: string; role: StaffRole },
    actingUser: { id: string; role: StaffRole },
  ) {
    const email = input.email.trim().toLowerCase();

    /**
     * You cannot invite someone at a level above your own.
     *
     * Without this, a MANAGER could invite a new OWNER, and then have that owner
     * remove the real one — a complete privilege-escalation path out of the role
     * system. Only an OWNER can mint an OWNER.
     */
    if (input.role === 'OWNER' && actingUser.role !== 'OWNER') {
      throw new ForbiddenException('Only an owner can invite another owner');
    }

    const existingStaff = await this.prisma.user.findFirst({
      where: { restaurantId, email, isActive: true },
    });
    if (existingStaff) {
      throw new ConflictException(`${email} is already on your team`);
    }

    const invite = await this.prisma.staffInvite.upsert({
      where: { restaurantId_email: { restaurantId, email } },
      // Re-inviting refreshes the link rather than erroring. "I invited them but
      // they lost the email" is the common case, and it should just work.
      update: {
        role: input.role,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        revokedAt: null,
        acceptedAt: null,
        invitedByUserId: actingUser.id,
      },
      create: {
        restaurantId,
        email,
        role: input.role,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
        invitedByUserId: actingUser.id,
      },
      include: { restaurant: true },
    });

    await this.sendInviteEmail(invite.email, invite.token, invite.restaurant, invite.role);

    await this.audit.log({
      restaurantId,
      userId: actingUser.id,
      action: 'staff.invited',
      entityType: 'StaffInvite',
      entityId: invite.id,
      metadata: { email, role: input.role },
    });

    this.logger.log(`Invited ${email} to ${invite.restaurant.slug} as ${input.role}`);

    // The token is deliberately NOT returned. It goes to the invitee's inbox and
    // nowhere else — an admin who can read it could impersonate the invitation.
    return { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt };
  }

  /** What the invitee sees before they decide to accept. Public, keyed by token. */
  async preview(token: string) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { token },
      include: { restaurant: { select: { name: true, logoUrl: true, slug: true } } },
    });

    if (!invite || invite.revokedAt) throw new NotFoundException('This invitation is not valid');
    if (invite.acceptedAt) throw new GoneException('This invitation has already been used');
    if (invite.expiresAt < new Date()) {
      throw new GoneException('This invitation has expired — ask for a new one');
    }

    return {
      email: invite.email,
      role: invite.role,
      restaurantName: invite.restaurant.name,
      restaurantLogoUrl: invite.restaurant.logoUrl,
    };
  }

  /**
   * Accept an invitation. The caller is an authenticated Clerk user.
   *
   * The email on their Clerk account must match the email the invite was sent to.
   * Otherwise a leaked invite link could be redeemed by whoever found it — the
   * token proves you received the email, but only the address proves you ARE the
   * person it was meant for.
   */
  async accept(token: string, clerkUserId: string) {
    const invite = await this.prisma.staffInvite.findUnique({
      where: { token },
      include: { restaurant: true },
    });

    if (!invite || invite.revokedAt) throw new NotFoundException('This invitation is not valid');
    if (invite.acceptedAt) throw new GoneException('This invitation has already been used');
    if (invite.expiresAt < new Date()) throw new GoneException('This invitation has expired');

    const clerkEmail = (await this.clerk.getPrimaryEmail(clerkUserId))?.toLowerCase();
    if (!clerkEmail) {
      throw new BadRequestException('Your account has no email address');
    }

    if (clerkEmail !== invite.email.toLowerCase()) {
      throw new ForbiddenException(
        `This invitation was sent to ${invite.email}. Sign in with that email to accept it.`,
      );
    }

    const clerkUser = await this.clerk.getUser(clerkUserId);

    const user = await this.prisma.$transaction(async (tx) => {
      // Idempotent: a double-click on the accept button must not create two
      // memberships (the unique index would reject the second anyway, but this
      // turns a 500 into the right answer).
      const existing = await tx.user.findUnique({
        where: {
          clerkUserId_restaurantId: { clerkUserId, restaurantId: invite.restaurantId },
        },
      });

      const member = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: { isActive: true, role: invite.role },
          })
        : await tx.user.create({
            data: {
              clerkUserId,
              email: clerkEmail,
              firstName: clerkUser.firstName,
              lastName: clerkUser.lastName,
              imageUrl: clerkUser.imageUrl,
              role: invite.role,
              restaurantId: invite.restaurantId,
            },
          });

      await tx.staffInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date() },
      });

      return member;
    });

    await this.audit.log({
      restaurantId: invite.restaurantId,
      userId: user.id,
      action: 'staff.invite_accepted',
      entityType: 'User',
      entityId: user.id,
      metadata: { email: clerkEmail, role: invite.role },
    });

    this.logger.log(`${clerkEmail} joined ${invite.restaurant.slug} as ${invite.role}`);

    return {
      restaurantId: invite.restaurantId,
      restaurantName: invite.restaurant.name,
      role: user.role,
    };
  }

  async revoke(restaurantId: string, inviteId: string, actingUserId: string) {
    const invite = await this.prisma.staffInvite.findFirst({
      where: { id: inviteId, restaurantId },
    });
    if (!invite) throw new NotFoundException('Invitation not found');

    await this.prisma.staffInvite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });

    await this.audit.log({
      restaurantId,
      userId: actingUserId,
      action: 'staff.invite_revoked',
      entityType: 'StaffInvite',
      entityId: inviteId,
      metadata: { email: invite.email },
    });
  }

  private async sendInviteEmail(
    email: string,
    token: string,
    restaurant: { name: string; logoUrl: string | null; brandPrimaryColor: string },
    role: StaffRole,
  ): Promise<void> {
    const webUrl = this.config.getOrThrow<string>('WEB_URL');
    const acceptUrl = `${webUrl}/invite/${token}`;

    const roleLabel =
      role === 'OWNER'
        ? 'an owner (full access, including payouts)'
        : role === 'MANAGER'
          ? 'a manager (menu, orders, staff and reports)'
          : 'staff (take and manage orders)';

    // Reuses EmailService's shell so invites look like everything else we send.
    await this.email.sendRaw({
      to: email,
      subject: `You've been invited to join ${restaurant.name} on OrderOS`,
      restaurant,
      body: `<h1 style="margin:0 0 8px;font-size:24px;">Join ${escapeHtml(restaurant.name)}</h1>
             <p style="margin:0 0 24px;color:#64748b;">
               You've been invited to OrderOS as ${escapeHtml(roleLabel)}.
             </p>
             <div style="margin-top:24px;">
               <a href="${escapeHtml(acceptUrl)}"
                  style="display:inline-block;background:${escapeHtml(restaurant.brandPrimaryColor)};color:#fff;
                         text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:600;font-size:15px;">
                 Accept invitation
               </a>
             </div>
             <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;">
               This link expires in ${INVITE_TTL_DAYS} days. Sign in with <strong>${escapeHtml(email)}</strong> —
               it only works for that address.
             </p>`,
    });
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
