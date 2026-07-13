import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { refundSchema, type RefundInput } from '@orderos/shared';
import type { Request } from 'express';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, CurrentUser, Public, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PaymentsService } from './payments.service';

/** Express gives us the raw body on this route only — see main.ts. */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@ApiTags('payments')
@Controller('payments')
@UseGuards(ClerkAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // --- Stripe Connect (dashboard) -------------------------------------------

  @Post('connect/onboarding-link')
  @Roles('OWNER')
  @Audit('stripe.onboarding_started', 'Restaurant')
  createOnboardingLink(@TenantId() restaurantId: string, @CurrentUser() user: AuthUser) {
    return this.payments.createConnectOnboardingLink(restaurantId, user.id);
  }

  @Get('connect/status')
  @Roles('MANAGER')
  connectStatus(@TenantId() restaurantId: string) {
    return this.payments.syncConnectStatus(restaurantId);
  }

  /** Single-use door into the restaurant's own Stripe Express dashboard. */
  @Post('connect/manage-link')
  @Roles('MANAGER')
  manageLink(@TenantId() restaurantId: string) {
    return this.payments.createExpressDashboardLink(restaurantId);
  }

  // --- Refunds (dashboard) ---------------------------------------------------

  @Post('orders/:orderId/refund')
  @Roles('MANAGER')
  @Audit('payment.refunded', 'Payment')
  refund(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(refundSchema)) body: RefundInput,
  ) {
    return this.payments.refund(restaurantId, orderId, body, user.id);
  }

  // --- Webhook ---------------------------------------------------------------

  /**
   * Stripe's webhook endpoint.
   *
   * @Public because Stripe has no Clerk session — but it is NOT unauthenticated:
   * the signature check in constructEvent() is the authentication, and it runs
   * before we look at a single field of the payload.
   *
   * Rate limiting is relaxed here because Stripe legitimately bursts (a backlog
   * after an outage), and throttling it away would mean losing paid orders.
   */
  @Post('webhook')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 500, ttl: 60_000 } })
  async webhook(@Req() req: RawBodyRequest, @Headers('stripe-signature') signature: string) {
    if (!signature) throw new BadRequestException('Missing stripe-signature header');
    if (!req.rawBody) {
      throw new BadRequestException('Raw body unavailable — webhook body parsing is misconfigured');
    }

    const event = this.payments.constructEvent(req.rawBody, signature);
    await this.payments.handleEvent(event);

    // 200 tells Stripe to stop retrying. We only get here if handleEvent didn't
    // throw, so a failure correctly leaves the event queued on Stripe's side.
    return { received: true };
  }
}
