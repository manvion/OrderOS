import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createRestaurantSchema, PLAN_TIERS, type PlanTier } from '@dinedirect/shared';
import { z } from 'zod';
import {
  PlatformAdminGuard,
  PlatformRoles,
  type PlatformRequest,
} from '../../common/auth/platform-admin.guard';
import { Public } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { LeadsService } from '../leads/leads.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { AdminService } from './admin.service';

const DEMO_STATUSES = ['NEW', 'CONTACTED', 'SCHEDULED', 'WON', 'LOST'] as const;
const demoStatusSchema = z.object({ status: z.enum(DEMO_STATUSES) });

/**
 * Onboarding a restaurant on their behalf, on a phone call.
 *
 * It takes the SAME input as the self-serve signup wizard — hours, fulfillment,
 * tax, ordering mode — and adds the two things only we can set. Sharing the schema
 * is the point: when the admin form and the signup form drift apart, the restaurant
 * we onboarded by hand is the one that goes live charging no sales tax, because
 * nobody was asked. That happened, and this is the fix.
 */
const adminCreateRestaurantSchema = createRestaurantSchema.extend({
  /** The person who will OWN this. They get an invite; we never set their password. */
  ownerEmail: z.string().email(),
  /** Our commission. Only we can see or set this. Omit to use the plan's default. */
  platformFeeBps: z.number().int().min(0).max(3000).optional(),
  /** Which plan to put them on from day one. Defaults to the free Starter tier. */
  planTier: z.enum(PLAN_TIERS as [PlanTier, ...PlanTier[]]).optional(),
  /**
   * An optional initial password for the owner. When present we create their account
   * immediately (they change it later); when absent we email them an invite instead.
   */
  ownerPassword: z.string().min(8).max(72).optional(),
});

const feeSchema = z.object({
  platformFeeBps: z.number().int().min(0).max(3000),
});

const suspendSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().min(3).max(500),
});

const planSchema = z.object({
  tier: z.enum(PLAN_TIERS as [string, ...string[]]),
});

const supportSchema = z.object({
  reason: z.string().min(3).max(500),
});

/**
 * The platform admin. Us, not the restaurants.
 *
 * @Public only means "skip the TENANT guard" — this controller is behind
 * PlatformAdminGuard, which checks a completely separate table. A restaurant owner
 * cannot reach any of this, whatever role they hold at their own restaurant.
 */
@ApiTags('admin')
@Controller('admin')
@Public()
@UseGuards(PlatformAdminGuard)
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly subscriptions: SubscriptionsService,
    private readonly leads: LeadsService,
  ) {}

  // --- Book-a-demo leads -----------------------------------------------------

  /** The inbound demo / done-for-you-setup pipeline. Any admin can work it. */
  @Get('demo-requests')
  listDemoRequests(@Query('status') status?: (typeof DEMO_STATUSES)[number]) {
    return this.leads.list(status);
  }

  @Patch('demo-requests/:id')
  updateDemoRequest(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(demoStatusSchema)) body: z.infer<typeof demoStatusSchema>,
  ) {
    return this.leads.updateStatus(id, body.status, req.admin!.email);
  }

  /** Who am I? Used by the web app to decide whether to show the admin at all. */
  @Get('me')
  me(@Req() req: PlatformRequest) {
    return req.admin;
  }

  @Get('overview')
  overview(@Query('days') days?: string) {
    return this.admin.getOverview(days ? Number(days) : 30);
  }

  @Get('restaurants')
  listRestaurants(
    @Query('search') search?: string,
    @Query('status') status?: 'live' | 'draft' | 'suspended',
    @Query('cursor') cursor?: string,
  ) {
    return this.admin.listRestaurants({ search, status, cursor });
  }

  @Get('restaurants/:id')
  getRestaurant(@Param('id') id: string) {
    return this.admin.getRestaurant(id);
  }

  /**
   * Onboard a restaurant for someone, then invite them to take ownership.
   *
   * The first fifty restaurants on any platform get set up by a human on a phone
   * call. This is that flow — but we still never create their account: the owner
   * accepts an invite and sets their own password, so we can never silently log in
   * as them.
   */
  @Post('restaurants')
  @PlatformRoles('SUPER_ADMIN')
  createRestaurant(
    @Req() req: PlatformRequest,
    @Body(new ZodValidationPipe(adminCreateRestaurantSchema))
    body: z.infer<typeof adminCreateRestaurantSchema>,
  ) {
    return this.admin.createRestaurantForOwner(body, req.admin!);
  }

  /** The price of the product. SUPER_ADMIN only — support must not be able to discount. */
  @Patch('restaurants/:id/fee')
  @PlatformRoles('SUPER_ADMIN')
  setFee(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(feeSchema)) body: z.infer<typeof feeSchema>,
  ) {
    return this.admin.setPlatformFee(id, body.platformFeeBps, req.admin!);
  }

  /** Switch a business off. Immediate, total, and reversible. Never deletes data. */
  @Patch('restaurants/:id/active')
  @PlatformRoles('SUPER_ADMIN')
  setActive(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(suspendSchema)) body: z.infer<typeof suspendSchema>,
  ) {
    return this.admin.setActive(id, body.isActive, body.reason, req.admin!);
  }

  /**
   * Put a restaurant on a plan for free — a comp, a promised upgrade, a partner.
   *
   * SUPER_ADMIN only, like the commission: this is giving away the product, and it
   * must not be something a support agent can do to placate an angry caller. No card
   * is charged and any existing paid subscription is left untouched.
   */
  @Patch('restaurants/:id/plan')
  @PlatformRoles('SUPER_ADMIN')
  setPlan(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(planSchema)) body: z.infer<typeof planSchema>,
  ) {
    return this.subscriptions.adminSetPlan(id, body.tier as never, req.admin!.email);
  }

  /**
   * Open a time-boxed session to act inside their dashboard and help them.
   *
   * Requires a written reason, expires in an hour, and lands on THEIR audit log —
   * a support tool the customer cannot see us using is a surveillance tool.
   */
  @Post('restaurants/:id/support-session')
  startSupport(
    @Req() req: PlatformRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(supportSchema)) body: z.infer<typeof supportSchema>,
  ) {
    return this.admin.startSupportSession(id, body.reason, req.admin!);
  }

  @Post('support-sessions/:sessionId/end')
  endSupport(@Req() req: PlatformRequest, @Param('sessionId') sessionId: string) {
    return this.admin.endSupportSession(sessionId, req.admin!);
  }

  /** The transparency record: who has been in whose data, and why. */
  @Get('support-sessions')
  listSupport(@Query('restaurantId') restaurantId?: string) {
    return this.admin.listSupportSessions(restaurantId);
  }

  @Get('admins')
  @PlatformRoles('SUPER_ADMIN')
  listAdmins() {
    return this.admin.listAdmins();
  }
}
