import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, CurrentUser, Public, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DomainsService } from './domains.service';

const addSchema = z.object({ domain: z.string().min(4).max(253) });

@ApiTags('domains')
@Controller('domains')
@UseGuards(ClerkAuthGuard)
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  list(@TenantId() restaurantId: string) {
    return this.domains.list(restaurantId);
  }

  /** Attach a domain the restaurant already owns. We don't sell domains. */
  @Post()
  @Roles('OWNER')
  @Audit('domain.added', 'CustomDomain')
  add(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(addSchema)) body: { domain: string },
  ) {
    return this.domains.add(restaurantId, body, user.id);
  }

  /**
   * "I've added the DNS records — check now."
   *
   * Throttled: DNS propagation takes minutes to hours, and an anxious owner
   * clicking this thirty times must not hammer Vercel's API on our behalf.
   */
  @Post(':id/check')
  @Roles('MANAGER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  check(@TenantId() restaurantId: string, @Param('id') id: string) {
    // Scoped to the caller's restaurant. Without the tenant in the lookup, a
    // manager at one restaurant could pass any domain id and read back another
    // restaurant's domain and its status.
    return this.domains.check(id, restaurantId);
  }

  @Delete(':id')
  @Roles('OWNER')
  @Audit('domain.removed', 'CustomDomain')
  async remove(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.domains.remove(restaurantId, id, user.id);
    return { success: true };
  }
}

/**
 * Host -> tenant, for the Next.js middleware.
 *
 * @Public and unauthenticated by necessity: it runs before we know who anyone is,
 * on every request arriving at a hostname the middleware doesn't recognise. It
 * reveals only whether a given domain maps to a published storefront — which is
 * already observable by simply visiting the domain.
 */
@ApiTags('domains')
@Controller('resolve')
export class DomainResolveController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  @Public()
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  async resolve(@Query('host') host: string) {
    return { slug: host ? await this.domains.resolveHost(host) : null };
  }
}
