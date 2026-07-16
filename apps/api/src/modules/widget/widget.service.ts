import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_WIDGET_SETTINGS,
  normalizeDomain,
  widgetSettingsSchema,
  WIDGET_KEY_PREFIX,
  type CreateIntegrationInput,
  type UpdateIntegrationInput,
  type WidgetSettings,
} from '@dinedirect/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';
import { assertRestaurantCapability } from '../../common/plan/plan.util';
import { AuditService } from '../../common/audit/audit.service';

@Injectable()
export class WidgetService {
  private readonly logger = new Logger(WidgetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // --- Dashboard: manage integrations ---------------------------------------

  async list(restaurantId: string) {
    return this.prisma.websiteIntegration.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async create(restaurantId: string, input: CreateIntegrationInput, userId?: string) {
    await assertRestaurantCapability(this.prisma, restaurantId, 'WIDGET');

    const domain = normalizeDomain(input.domain);
    if (!domain) {
      throw new BadRequestException(
        `"${input.domain}" is not a valid domain. Enter it like "joesburgers.com".`,
      );
    }

    const existing = await this.prisma.websiteIntegration.findFirst({
      where: { restaurantId, domain },
    });
    if (existing) {
      throw new ConflictException(`You already have an integration for ${domain}`);
    }

    const settings = widgetSettingsSchema.parse({
      ...DEFAULT_WIDGET_SETTINGS,
      ...(input.settings ?? {}),
    });

    const integration = await this.prisma.websiteIntegration.create({
      data: {
        restaurantId,
        name: input.name,
        domain,
        widgetKey: this.generateWidgetKey(),
        // Seed the allowlist with the domain itself. `www.` is handled at match
        // time (see isOriginAllowed), so we don't store both.
        allowedDomains: [domain],
        settings: settings as unknown as Prisma.InputJsonValue,
      },
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'widget.integration_created',
      entityType: 'WebsiteIntegration',
      entityId: integration.id,
      metadata: { domain, name: input.name },
    });

    return integration;
  }

  async update(
    restaurantId: string,
    id: string,
    input: UpdateIntegrationInput,
    userId?: string,
  ) {
    const existing = await this.prisma.websiteIntegration.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('Integration not found');

    let allowedDomains: string[] | undefined;
    if (input.allowedDomains) {
      const normalized = input.allowedDomains.map((d) => ({ raw: d, host: normalizeDomain(d) }));
      const invalid = normalized.filter((d) => !d.host);
      if (invalid.length) {
        throw new BadRequestException(
          `Not a valid domain: ${invalid.map((d) => `"${d.raw}"`).join(', ')}`,
        );
      }
      allowedDomains = [...new Set(normalized.map((d) => d.host!))];
    }

    // Merge rather than replace: the dashboard sends only the fields it changed,
    // and a partial PATCH must not silently reset the owner's other choices.
    const settings = input.settings
      ? widgetSettingsSchema.parse({
          ...(existing.settings as unknown as WidgetSettings),
          ...input.settings,
        })
      : undefined;

    const integration = await this.prisma.websiteIntegration.update({
      where: { id },
      data: {
        ...(input.name ? { name: input.name } : {}),
        ...(allowedDomains ? { allowedDomains } : {}),
        ...(settings ? { settings: settings as unknown as Prisma.InputJsonValue } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    await this.invalidate(existing.widgetKey, existing.allowedDomains, integration.allowedDomains);

    await this.audit.log({
      restaurantId,
      userId,
      action: 'widget.integration_updated',
      entityType: 'WebsiteIntegration',
      entityId: id,
      metadata: { fields: Object.keys(input) },
    });

    return integration;
  }

  /**
   * Mint a new widget key, invalidating the old one.
   *
   * The old key stops working the moment this returns — which means the
   * restaurant's live website breaks until they paste the new snippet in. That is
   * the correct behaviour for a rotate (it's what makes it a rotate), but the
   * dashboard must warn them loudly, and does.
   */
  async rotateKey(restaurantId: string, id: string, userId?: string) {
    const existing = await this.prisma.websiteIntegration.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('Integration not found');

    const integration = await this.prisma.websiteIntegration.update({
      where: { id },
      data: { widgetKey: this.generateWidgetKey(), installedAt: null, lastSeenAt: null },
    });

    await this.invalidate(existing.widgetKey, existing.allowedDomains, integration.allowedDomains);

    await this.audit.log({
      restaurantId,
      userId,
      action: 'widget.key_rotated',
      entityType: 'WebsiteIntegration',
      entityId: id,
    });

    this.logger.log(`Widget key rotated for integration ${id}`);
    return integration;
  }

  async remove(restaurantId: string, id: string, userId?: string) {
    const existing = await this.prisma.websiteIntegration.findFirst({
      where: { id, restaurantId },
    });
    if (!existing) throw new NotFoundException('Integration not found');

    // Orders keep a nullable reference (SetNull), so deleting an integration
    // loses its attribution but never its orders.
    await this.prisma.websiteIntegration.delete({ where: { id } });
    await this.invalidate(existing.widgetKey, existing.allowedDomains, []);

    await this.audit.log({
      restaurantId,
      userId,
      action: 'widget.integration_deleted',
      entityType: 'WebsiteIntegration',
      entityId: id,
      metadata: { domain: existing.domain },
    });
  }

  // --- Widget runtime --------------------------------------------------------

  /**
   * Everything the widget needs to render itself, in one request: branding,
   * settings, and whether the restaurant is open. The loader fetches this before
   * it paints anything, so there's exactly one round trip before the button appears.
   */
  async getPublicConfig(integrationId: string) {
    const integration = await this.prisma.websiteIntegration.findUnique({
      where: { id: integrationId },
      select: {
        id: true,
        settings: true,
        restaurant: {
          select: {
            id: true,
            slug: true,
            name: true,
            logoUrl: true,
            currency: true,
            brandPrimaryColor: true,
            pickupEnabled: true,
            deliveryEnabled: true,
            dineInEnabled: true,
            minOrderCents: true,
            // Not selected: email, stripeAccountId, platformFeeBps, taxRateBps
            // internals. This payload is world-readable — treat it as such.
          },
        },
      },
    });
    if (!integration) throw new NotFoundException('Widget not found');

    return {
      settings: integration.settings as unknown as WidgetSettings,
      restaurant: integration.restaurant,
    };
  }

  /**
   * Record that the widget was seen alive on the customer's real website.
   *
   * Fire-and-forget from the VIEW event. The dashboard turns this into
   * "Installed ✓ — last seen 2 minutes ago", which is the difference between an
   * owner who knows the snippet is working and one who files a support ticket.
   */
  async touchInstalled(integrationId: string): Promise<void> {
    const now = new Date();
    try {
      // Two writes, because `installedAt` must be stamped once and then left
      // alone — it's the install date, not "now". The updateMany's `installedAt:
      // null` predicate makes the first-sight case a no-op on every later call.
      await this.prisma.websiteIntegration.updateMany({
        where: { id: integrationId, installedAt: null },
        data: { installedAt: now },
      });
      await this.prisma.websiteIntegration.update({
        where: { id: integrationId },
        data: { lastSeenAt: now },
      });
    } catch {
      // Non-critical telemetry. Never fail a widget load over it.
    }
  }

  private generateWidgetKey(): string {
    // 32 hex chars. Not a secret (see WidgetTenantGuard) but it must be
    // unguessable enough that nobody can enumerate other restaurants' widgets.
    return `${WIDGET_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
  }

  /**
   * Bust the guard's cache, and the CORS origin cache for every domain that was
   * on the allowlist before OR after the change — a removed domain must stop
   * being allowed immediately, not in two minutes.
   */
  private async invalidate(
    widgetKey: string,
    oldDomains: string[],
    newDomains: string[],
  ): Promise<void> {
    const keys = [
      `widget:key:${widgetKey}`,
      ...new Set([...oldDomains, ...newDomains]).values(),
    ].map((k) => (k.startsWith('widget:key:') ? k : `widget:origin:${k}`));

    await this.redis.del(...keys);
  }

  /**
   * Is this browser Origin registered by ANY restaurant? Used by the CORS layer
   * in main.ts, which runs before routing and therefore before any guard.
   *
   * Cached hard: it is consulted on every preflight.
   */
  async isOriginRegistered(origin: string): Promise<boolean> {
    let host: string;
    try {
      host = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    const bare = host.startsWith('www.') ? host.slice(4) : host;

    const cacheKey = `widget:origin:${bare}`;
    const cached = await this.redis.get<boolean>(cacheKey);
    if (cached !== null) return cached;

    const match = await this.prisma.websiteIntegration.findFirst({
      where: { allowedDomains: { has: bare }, isActive: true },
      select: { id: true },
    });

    const allowed = Boolean(match);
    // Cache negatives too, and briefly — otherwise a page hammering us from an
    // unregistered origin means a DB hit per preflight.
    await this.redis.set(cacheKey, allowed, allowed ? 300 : 60);
    return allowed;
  }
}
