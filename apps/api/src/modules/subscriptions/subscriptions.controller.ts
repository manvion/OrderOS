import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PLAN_TIERS } from '@dinedirect/shared';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Public, Roles, TenantId } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { SubscriptionsService } from './subscriptions.service';

const checkoutSchema = z.object({
  tier: z.enum(PLAN_TIERS as [string, ...string[]]),
  interval: z.enum(['MONTHLY', 'ANNUAL']),
});

@ApiTags('subscriptions')
@Controller('subscriptions')
@UseGuards(ClerkAuthGuard)
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  /**
   * The public pricing table, localised by currency. Used by the marketing page,
   * which has no session — so it's @Public. Everything else here is behind the
   * tenant guard.
   */
  @Get('pricing')
  @Public()
  pricing(@Query('currency') currency?: string) {
    return this.subscriptions.getPricing(currency);
  }

  /** The signed-in restaurant's current plan, plus the tiers it can move to. */
  @Get('plan')
  plan(@TenantId() restaurantId: string) {
    return this.subscriptions.getPlanState(restaurantId);
  }

  /** Start Stripe Checkout for a paid plan. Only an owner can spend the restaurant's money. */
  @Post('checkout')
  @Roles('OWNER')
  checkout(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(checkoutSchema)) body: z.infer<typeof checkoutSchema>,
  ) {
    return this.subscriptions.createCheckoutSession(
      restaurantId,
      body.tier as never,
      body.interval,
    );
  }

  /** A link into Stripe's billing portal to manage or cancel the subscription. */
  @Post('portal')
  @Roles('OWNER')
  portal(@TenantId() restaurantId: string) {
    return this.subscriptions.createPortalLink(restaurantId);
  }
}
