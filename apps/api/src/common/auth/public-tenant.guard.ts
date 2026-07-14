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
 *   2. The Host subdomain — `joes.dinedirect.manvion.ca` -> `joes`.
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

      if (restaurant) {
        restaurantId = restaurant.id;
        await this.redis.set(cacheKey, restaurantId, PublicTenantGuard.CACHE_TTL_SECONDS);
      } else {
        /**
         * Not published. One door remains: a PREVIEW token, minted by the
         * restaurant's own dashboard, so the owner can see their page before
         * customers can. Without this not even the owner could look at an
         * unpublished storefront — setup ended in a leap of faith ("publish and
         * find out"), and every owner who clicked their address link pre-publish
         * filed the 404 as a bug. They were right to.
         *
         * The token is random, single-tenant, 30-minute, staff-minted. The
         * resolved id is deliberately NOT written to the tenant cache: that cache
         * feeds ordinary public traffic, and an unpublished restaurant must stay
         * invisible to everyone who isn't holding the token.
         */
        const presented = req.headers['x-preview-token'];
        const expected = await this.redis.get<string>(`preview:${slug}`);

        if (!expected || typeof presented !== 'string' || presented !== expected) {
          throw new NotFoundException('Restaurant not found');
        }

        const unpublished = await this.prisma.restaurant.findFirst({
          where: { slug, isActive: true },
          select: { id: true },
        });
        if (!unpublished) throw new NotFoundException('Restaurant not found');

        restaurantId = unpublished.id;
        req.isPreviewRequest = true;
      }
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
      // Reject nested subdomains ("a.b.dinedirect.manvion.ca") — only one label is a tenant.
      return sub.includes('.') ? null : sub;
    }

    // Local development: joes.localhost:3000
    if (hostname.endsWith('.localhost')) {
      return hostname.slice(0, -'.localhost'.length);
    }

    return null;
  }
}
