import {
  Body,
  Controller,
  ForbiddenException,
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
import type { Request } from 'express';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, CurrentUser, Public, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { DeliveryService } from './delivery.service';
import { UberClient } from './uber.client';

const selfDeliverySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  phone: z.string().min(7).max(20).optional(),
});

const selfStatusSchema = z.object({
  status: z.enum(['OUT_FOR_DELIVERY', 'DELIVERED']),
});

const handoffSchema = z
  .object({
    code: z.string().max(12).optional(),
    /**
     * The escape hatch. If the code system fails (Uber didn't surface it, the
     * driver's app crashed), staff must still be able to give the courier the food
     * — a safety control that cannot be overridden is one that gets worked around,
     * usually by turning the whole feature off. So we allow it, demand a reason,
     * and write it to the audit log.
     */
    override: z.boolean().optional(),
    overrideReason: z.string().max(200).optional(),
  })
  .refine((b) => Boolean(b.code) || b.override === true, {
    message: 'Enter the code the driver reads out, or override with a reason',
    path: ['code'],
  });

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

@ApiTags('delivery')
@Controller('delivery')
@UseGuards(ClerkAuthGuard)
export class DeliveryController {
  constructor(
    private readonly delivery: DeliveryService,
    private readonly uber: UberClient,
  ) {}

  @Get('orders/:orderId')
  get(@TenantId() restaurantId: string, @Param('orderId') orderId: string) {
    return this.delivery.getByOrder(restaurantId, orderId);
  }

  /**
   * The courier's route so far, for the map on the restaurant's order detail.
   *
   * Staff want this as much as customers do: "where is my driver" is the question
   * they get phoned about, and before this the only answer was to open Uber's own
   * dashboard in another tab.
   */
  @Get('orders/:orderId/trail')
  async trail(@TenantId() restaurantId: string, @Param('orderId') orderId: string) {
    const delivery = await this.delivery.getByOrder(restaurantId, orderId);
    return {
      courierLatitude: delivery.courierLatitude,
      courierLongitude: delivery.courierLongitude,
      pings: await this.delivery.getCourierTrail(delivery.id),
    };
  }

  /**
   * Dispatch a courier. STAFF-level on purpose: whoever marks the order ready is
   * the person who should be able to call the driver, and blocking on a manager
   * means food sitting under a heat lamp.
   */
  @Post('orders/:orderId')
  @Audit('delivery.created', 'Delivery')
  create(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
  ) {
    return this.delivery.createDelivery(restaurantId, orderId, user.id);
  }

  /**
   * "We'll take this one ourselves."
   *
   * STAFF-level, like Uber dispatch: whoever is standing at the pass when the food
   * is ready is the person who knows whether the moped kid is on shift.
   */
  @Post('orders/:orderId/self')
  @Audit('delivery.self_assigned', 'Delivery')
  selfDeliver(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(selfDeliverySchema)) body: { name?: string; phone?: string },
  ) {
    return this.delivery.createSelfDelivery(restaurantId, orderId, body, user.id);
  }

  /** Move our own driver along. Uber sends webhooks; our own driver does not. */
  @Post('orders/:orderId/self/status')
  @Audit('delivery.self_status_changed', 'Delivery')
  selfStatus(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(selfStatusSchema))
    body: { status: 'OUT_FOR_DELIVERY' | 'DELIVERED' },
  ) {
    return this.delivery.markSelfDeliveryStatus(restaurantId, orderId, body.status, user.id);
  }

  /**
   * Verify the courier standing at the counter is collecting THIS order.
   *
   * Staff ask the driver for their pickup code and type it in. A mismatch refuses
   * — which is the whole point, because handing the wrong bag to the wrong driver
   * is the most expensive routine mistake in delivery.
   */
  @Post('orders/:orderId/handoff')
  @Audit('delivery.handed_over', 'Delivery')
  handoff(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(handoffSchema)) body: z.infer<typeof handoffSchema>,
  ) {
    return this.delivery.verifyHandoff(restaurantId, orderId, body, user.id);
  }

  @Post('orders/:orderId/cancel')
  @Audit('delivery.cancelled', 'Delivery')
  cancel(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
  ) {
    return this.delivery.cancelDelivery(restaurantId, orderId, user.id);
  }

  /** Manual poll, for when a webhook goes missing. */
  @Post('orders/:orderId/refresh')
  refresh(@TenantId() restaurantId: string, @Param('orderId') orderId: string) {
    return this.delivery.refreshStatus(restaurantId, orderId);
  }

  /**
   * Uber Direct's webhook.
   *
   * @Public, but authenticated by HMAC: we verify the signature over the RAW
   * body before touching the payload. An unsigned request is rejected with 403
   * and never reaches the service — otherwise anyone who learned a delivery id
   * could mark an order delivered and stop the customer's refund clock.
   */
  @Post('webhook')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 500, ttl: 60_000 } })
  async webhook(
    @Req() req: RawBodyRequest,
    @Headers('x-postmates-signature') signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (!req.rawBody) {
      throw new ForbiddenException('Raw body unavailable — webhook parsing is misconfigured');
    }
    if (!this.uber.verifyWebhookSignature(req.rawBody, signature)) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    await this.delivery.handleWebhook(body);
    return { received: true };
  }
}
