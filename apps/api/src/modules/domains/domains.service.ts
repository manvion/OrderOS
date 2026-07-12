import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeDomain, RESERVED_SLUGS } from '@orderos/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { AuditService } from '../../common/audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { VercelClient } from './vercel.client';

/** Give up polling after this many failed checks (~2 days at the backoff below). */
const MAX_CHECK_ATTEMPTS = 60;

@Injectable()
export class DomainsService {
  private readonly logger = new Logger(DomainsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly vercel: VercelClient,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  async list(restaurantId: string) {
    return this.prisma.customDomain.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Attach a restaurant's own domain.
   *
   * We do NOT sell or register domains — the owner buys `joesburgers.com` from
   * whoever they like. Our job is to attach it and to tell them, exactly, which two
   * lines to paste into their registrar's DNS panel. That instruction is the whole
   * product here: "add a CNAME" is where non-technical restaurant owners give up,
   * so we compute the precise records and show them verbatim.
   */
  async add(restaurantId: string, input: { domain: string }, userId?: string) {
    this.vercel.assertConfigured();

    const domain = normalizeDomain(input.domain);
    if (!domain) {
      throw new BadRequestException(
        `"${input.domain}" is not a valid domain. Enter it like "joesburgers.com".`,
      );
    }

    // Never let a tenant claim one of our own hostnames.
    const appDomain = this.config.getOrThrow<string>('APP_DOMAIN');
    if (domain === appDomain || domain.endsWith(`.${appDomain}`)) {
      throw new BadRequestException(
        `You already have ${domain} through us. Add a domain you own instead.`,
      );
    }
    if (RESERVED_SLUGS.includes(domain.split('.')[0])) {
      throw new BadRequestException('That domain is reserved');
    }

    const existing = await this.prisma.customDomain.findUnique({ where: { domain } });
    if (existing) {
      // Same restaurant re-adding it: hand back what they have. Another restaurant:
      // refuse, and do not reveal who holds it.
      if (existing.restaurantId === restaurantId) return existing;
      throw new ConflictException('That domain is already connected to another account');
    }

    // Attach it to the one multi-tenant Vercel project. No build, no repo.
    const status = await this.vercel.addDomain(domain);

    const record = await this.prisma.customDomain.create({
      data: {
        restaurantId,
        domain,
        status: status.verified ? 'ACTIVE' : 'PENDING_DNS',
        dnsRecords: status.requiredRecords as unknown as Prisma.InputJsonValue,
        vercelConfigured: true,
        sslActive: status.verified,
        verifiedAt: status.verified ? new Date() : null,
      },
    });

    if (status.verified) await this.onVerified(record.id);

    await this.audit.log({
      restaurantId,
      userId,
      action: 'domain.added',
      entityType: 'CustomDomain',
      entityId: record.id,
      metadata: { domain },
    });

    this.logger.log(`Restaurant ${restaurantId} attached ${domain}`);
    return record;
  }

  /**
   * Ask Vercel where this domain actually stands. Called by the owner clicking
   * "Check now", and by the cron below.
   */
  async check(domainId: string, restaurantId?: string) {
    // `restaurantId` is supplied by the dashboard and omitted by the cron, which
    // legitimately sweeps every tenant's pending domains.
    const record = await this.prisma.customDomain.findFirst({
      where: { id: domainId, ...(restaurantId ? { restaurantId } : {}) },
    });
    if (!record) throw new NotFoundException('Domain not found');
    if (record.status === 'ACTIVE') return record;

    let status;
    try {
      status = await this.vercel.getStatus(record.domain);
    } catch (err) {
      return this.prisma.customDomain.update({
        where: { id: domainId },
        data: {
          error: (err as Error).message,
          checkAttempts: { increment: 1 },
          lastCheckedAt: new Date(),
        },
      });
    }

    const updated = await this.prisma.customDomain.update({
      where: { id: domainId },
      data: {
        status: status.verified ? 'ACTIVE' : 'PENDING_DNS',
        sslActive: status.verified,
        dnsRecords: status.requiredRecords as unknown as Prisma.InputJsonValue,
        // Not an error the owner needs to see in red — DNS takes time, sometimes
        // hours. The UI says "waiting for DNS", not "failed".
        error: status.verified ? null : status.error,
        checkAttempts: { increment: 1 },
        lastCheckedAt: new Date(),
        ...(status.verified ? { verifiedAt: new Date() } : {}),
      },
    });

    if (status.verified && !record.verifiedAt) {
      await this.onVerified(domainId);
    }

    return updated;
  }

  /**
   * The domain went live. Two things must happen, and both are easy to forget:
   *
   *  1. APPLE PAY. Stripe registers Apple Pay per DOMAIN. A restaurant that moves to
   *     joesburgers.com and isn't re-registered loses the Apple Pay button on every
   *     iPhone — with no error, anywhere. This is the exact bug that eats a day.
   *
   *  2. CACHE. The host->tenant lookup is cached; a domain that takes five minutes
   *     to start resolving is a domain the owner thinks is broken.
   */
  private async onVerified(domainId: string): Promise<void> {
    const record = await this.prisma.customDomain.findUnique({
      where: { id: domainId },
      include: { restaurant: { select: { slug: true, name: true } } },
    });
    if (!record) return;

    const registered = await this.payments.registerApplePayDomain(record.domain);

    await this.prisma.customDomain.update({
      where: { id: domainId },
      data: { applePayRegistered: registered, status: 'ACTIVE' },
    });

    await this.redis.del(`domain:${record.domain}`);

    await this.audit.log({
      restaurantId: record.restaurantId,
      action: 'domain.verified',
      entityType: 'CustomDomain',
      entityId: domainId,
      metadata: { domain: record.domain, applePayRegistered: registered },
    });

    this.logger.log(
      `${record.domain} is LIVE for ${record.restaurant.name}` +
        (registered ? ' (Apple Pay registered)' : ' — Apple Pay registration FAILED'),
    );
  }

  async remove(restaurantId: string, domainId: string, userId?: string) {
    const record = await this.prisma.customDomain.findFirst({
      where: { id: domainId, restaurantId },
    });
    if (!record) throw new NotFoundException('Domain not found');

    await this.vercel.removeDomain(record.domain);
    await this.prisma.customDomain.delete({ where: { id: domainId } });
    await this.redis.del(`domain:${record.domain}`);

    await this.audit.log({
      restaurantId,
      userId,
      action: 'domain.removed',
      entityType: 'CustomDomain',
      entityId: domainId,
      metadata: { domain: record.domain },
    });
  }

  /**
   * Host -> restaurant slug. Called by the Next.js middleware on EVERY request that
   * arrives on a domain it doesn't recognise.
   *
   * Cached hard, negatives included: this is the hottest lookup in the system, and
   * without a negative cache every request to a stranger's misconfigured domain
   * would be a database hit.
   */
  async resolveHost(host: string): Promise<string | null> {
    const domain = normalizeDomain(host);
    if (!domain) return null;

    const cacheKey = `domain:${domain}`;
    const cached = await this.redis.get<{ slug: string | null }>(cacheKey);
    if (cached) return cached.slug;

    const record = await this.prisma.customDomain.findFirst({
      where: {
        domain,
        status: 'ACTIVE',
        restaurant: { isPublished: true, isActive: true },
      },
      select: { restaurant: { select: { slug: true } } },
    });

    const slug = record?.restaurant.slug ?? null;
    await this.redis.set(cacheKey, { slug }, slug ? 300 : 60);

    return slug;
  }

  /** Is this origin a live storefront domain? Used by the CORS layer. */
  async isKnownStorefrontOrigin(origin: string): Promise<boolean> {
    try {
      return Boolean(await this.resolveHost(new URL(origin).hostname));
    } catch {
      return false;
    }
  }

  /** Domains still waiting on DNS. Drained by the cron with backoff. */
  async listPending() {
    return this.prisma.customDomain.findMany({
      where: {
        status: { in: ['PENDING_DNS', 'ISSUING_CERT'] },
        checkAttempts: { lt: MAX_CHECK_ATTEMPTS },
      },
      select: { id: true, domain: true, checkAttempts: true, lastCheckedAt: true },
      take: 50,
    });
  }
}
