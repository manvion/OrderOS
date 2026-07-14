import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { isOriginAllowed } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import type { AuthedRequest } from '../../common/auth/request-context';

export interface WidgetContext {
  integrationId: string;
  restaurantId: string;
  origin: string;
}

/** Set by the guard, read by the controllers. */
export interface WidgetRequest extends AuthedRequest {
  widget?: WidgetContext;
}

interface CachedIntegration {
  id: string;
  restaurantId: string;
  allowedDomains: string[];
  isActive: boolean;
  restaurantPublished: boolean;
}

/**
 * Authorises embedded-widget traffic.
 *
 * The widget key is PUBLIC — it sits in the restaurant's page source and anyone
 * can read it. So it is an identifier, not a credential, and this guard treats it
 * that way. What actually authorises the request is the pair (key, Origin): the
 * browser sets Origin and a page cannot forge it, so a key scraped from joes.com
 * and pasted into evil.com produces an Origin that isn't on Joe's allowlist and
 * the request is refused.
 *
 * That leaves a deliberate, understood gap: a non-browser client (curl) can send
 * any Origin it likes. This is unavoidable for any public embed — the widget must
 * work with no secret on a static HTML page. It is acceptable because the widget
 * API exposes nothing an attacker couldn't get by loading the restaurant's public
 * storefront: a menu, and the ability to create an *unpaid* order. Money still
 * requires Stripe. What the Origin check genuinely buys us is preventing a third
 * party from running someone else's ordering widget on their own site, and
 * scoping CORS so a browser won't hand a rogue page our responses.
 */
@Injectable()
export class WidgetTenantGuard implements CanActivate {
  private readonly logger = new Logger(WidgetTenantGuard.name);
  private static readonly CACHE_TTL_SECONDS = 120;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<WidgetRequest>();

    const widgetKey =
      (req.headers['x-widget-key'] as string | undefined) ??
      (req.query?.key as string | undefined);

    if (!widgetKey) throw new NotFoundException('Widget not found');

    const integration = await this.load(widgetKey);
    if (!integration || !integration.isActive) {
      // Same 404 for "no such key" and "disabled key" — no enumeration signal.
      throw new NotFoundException('Widget not found');
    }

    // A restaurant that unpublished its storefront has stopped taking orders. The
    // widget must stop too, or their site keeps accepting orders they've turned off.
    if (!integration.restaurantPublished) {
      throw new NotFoundException('This restaurant is not currently accepting orders');
    }

    const origin = req.headers.origin;
    if (!origin) {
      // A browser always sends Origin on a cross-origin request, which every
      // widget request is by definition. Its absence means this isn't the widget.
      throw new ForbiddenException('Missing Origin header');
    }

    if (!isOriginAllowed(origin, integration.allowedDomains)) {
      this.logger.warn(
        `Widget key ${widgetKey.slice(0, 12)}… used from unregistered origin ${origin}`,
      );
      throw new ForbiddenException(
        'This widget is not authorised for this domain. Add it in your DineDirect dashboard.',
      );
    }

    req.widget = {
      integrationId: integration.id,
      restaurantId: integration.restaurantId,
      origin,
    };
    // Reuse the tenant plumbing the rest of the app already speaks, so widget
    // requests are scoped exactly like every other request.
    req.publicRestaurantId = integration.restaurantId;

    return true;
  }

  /**
   * Cached: this runs on every widget request, and the allowlist changes about as
   * often as a restaurant redesigns its website. WidgetService busts the key on
   * every write.
   */
  private async load(widgetKey: string): Promise<CachedIntegration | null> {
    const cacheKey = `widget:key:${widgetKey}`;

    const cached = await this.redis.get<CachedIntegration>(cacheKey);
    if (cached) return cached;

    const integration = await this.prisma.websiteIntegration.findUnique({
      where: { widgetKey },
      select: {
        id: true,
        restaurantId: true,
        allowedDomains: true,
        isActive: true,
        restaurant: { select: { isPublished: true, isActive: true } },
      },
    });
    if (!integration) return null;

    const value: CachedIntegration = {
      id: integration.id,
      restaurantId: integration.restaurantId,
      allowedDomains: integration.allowedDomains,
      isActive: integration.isActive,
      restaurantPublished: integration.restaurant.isPublished && integration.restaurant.isActive,
    };

    await this.redis.set(cacheKey, value, WidgetTenantGuard.CACHE_TTL_SECONDS);
    return value;
  }
}
