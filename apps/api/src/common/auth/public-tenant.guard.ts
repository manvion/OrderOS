import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { AuthedRequest } from './request-context';

/**
 * Resolves the tenant for unauthenticated storefront traffic.
 *
 * Resolution order:
 *   1. `X-Restaurant-Slug` header — set by the Next.js server when it proxies.
 *   2. The Host subdomain — `joes.orderos.ai` -> `joes`.
 *
 * Only PUBLISHED, ACTIVE restaurants resolve. An unpublished tenant 404s, so a
 * half-configured restaurant can't take orders it can't fulfil.
 *
 * The slug -> id lookup is cached in Redis: it's on every storefront request and
 * effectively never changes.
 */
@Injectable()
export class PublicTenantGuard implements CanActivate {
  private static readonly CACHE_TTL_SECONDS = 300;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const slug = this.extractSlug(req);
    if (!slug) throw new NotFoundException('Restaurant not found');

    const cacheKey = `tenant:slug:${slug}`;
    let restaurantId = await this.redis.get<string>(cacheKey);

    if (!restaurantId) {
      const restaurant = await this.prisma.restaurant.findFirst({
        where: { slug, isPublished: true, isActive: true },
        select: { id: true },
      });
      if (!restaurant) throw new NotFoundException('Restaurant not found');
      restaurantId = restaurant.id;
      await this.redis.set(cacheKey, restaurantId, PublicTenantGuard.CACHE_TTL_SECONDS);
    }

    req.publicRestaurantId = restaurantId;
    return true;
  }

  private extractSlug(req: AuthedRequest): string | null {
    const headerSlug = req.headers['x-restaurant-slug'];
    if (typeof headerSlug === 'string' && headerSlug.length > 0) {
      return headerSlug.toLowerCase();
    }

    const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? '';
    const hostname = host.split(':')[0].toLowerCase();
    const appDomain = this.config.getOrThrow<string>('APP_DOMAIN');

    if (hostname.endsWith(`.${appDomain}`)) {
      const sub = hostname.slice(0, -(appDomain.length + 1));
      // Reject nested subdomains ("a.b.orderos.ai") — only one label is a tenant.
      return sub.includes('.') ? null : sub;
    }

    // Local development: joes.localhost:3000
    if (hostname.endsWith('.localhost')) {
      return hostname.slice(0, -'.localhost'.length);
    }

    return null;
  }
}
