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
import { DoorDashClient } from './doordash.client';
import { UberClient } from './uber.client';

const selfDeliverySchema = z.object({
  name: z.string().min(1).max(80).optional(),
  phone: z.string().min(7).max(20).optional(),
});

const selfStatusSchema = z.object({
  status: z.enum(['OUT_FOR_DELIVERY', 'DELIVERED']),
});

const driverPingSchema = z.object({
  lat: z.number().gte(-90).lte(90),
  lng: z.number().gte(-180).lte(180),
});

const driverStatusSchema = z.object({
  status: z.enum(['OUT_FOR_DELIVERY', 'DELIVERED']),
  /**
   * Optional proof-of-delivery photo as a data URL, sent with a DELIVERED. The web
   * page compresses it to a small JPEG first; capped here as a coarse guard against a
   * multi-megabyte body (the storage layer enforces the real 5MB image limit).
   */
  photo: z.string().max(8_000_000).optional(),
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

/** A live courier quote for the POS when staff take a delivery order at the counter. */
const quoteSchema = z.object({
  address: z.object({
    street: z.string().min(1).max(200),
    city: z.string().min(1).max(120),
    state: z.string().max(120).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().max(60).optional(),
  }),
  orderValueCents: z.number().int().min(0).max(1_000_000),
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
    private readonly doordash: DoorDashClient,
  ) {}

  @Get('orders/:orderId')
  get(@TenantId() restaurantId: string, @Param('orderId') orderId: string) {
    return this.delivery.getByOrder(restaurantId, orderId);
  }

  /**
   * A live courier quote for a counter-taken delivery order, so the POS can charge the
   * real Uber fee for the entered address instead of a flat rate. Returns { deliverable,
   * customerFeeCents, selfDelivery, ... } or a not-deliverable reason.
   */
  @Post('quote')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  quote(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(quoteSchema)) body: z.infer<typeof quoteSchema>,
  ) {
    return this.delivery.getQuote(
      restaurantId,
      {
        street: body.address.street,
        city: body.address.city,
        state: body.address.state ?? '',
        postalCode: body.address.postalCode ?? '',
        country: body.address.country ?? '',
      },
      body.orderValueCents,
    );
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
   * The restaurant's own driver, sharing live location from their phone.
   *
   * All three routes are @Public and authorised ONLY by the unguessable share token
   * in the URL — the driver is not a logged-in user of ours, they just scanned a QR
   * the kitchen showed them. Same capability-URL trust model as the customer's
   * tracking link. Throttled hard because a phone streaming GPS is a chatty client
   * and the token is the only gate.
   */
  @Get('driver/:token')
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  driverContext(@Param('token') token: string) {
    return this.delivery.getDriverContext(token);
  }

  @Post('driver/:token/ping')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  driverPing(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(driverPingSchema)) body: { lat: number; lng: number },
  ) {
    return this.delivery.recordDriverPing(token, body);
  }

  @Post('driver/:token/status')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  driverStatus(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(driverStatusSchema))
    body: z.infer<typeof driverStatusSchema>,
  ) {
    return this.delivery.advanceDriverStatus(token, body.status, body.photo);
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

  /**
   * DoorDash Drive's webhook.
   *
   * A sibling of the Uber one, not a branch inside it: the two sign differently
   * (different header, different secret) and their payloads share no field names, so
   * a single endpoint sniffing which courier sent it would be guessing about
   * authentication — which is the one thing here that must never be a guess.
   *
   * Lives under /webhook/* so main.ts's raw-body carve-out for `/api/delivery/webhook`
   * covers it by prefix. Verifying a signature against a re-serialized body fails on
   * key order alone.
   */
  @Post('webhook/doordash')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 500, ttl: 60_000 } })
  async doorDashWebhook(
    @Req() req: RawBodyRequest,
    @Headers('x-doordash-signature') signature: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (!req.rawBody) {
      throw new ForbiddenException('Raw body unavailable — webhook parsing is misconfigured');
    }
    if (!this.doordash.verifyWebhookSignature(req.rawBody, { 'x-doordash-signature': signature })) {
      throw new ForbiddenException('Invalid webhook signature');
    }

    await this.delivery.handleDoorDashWebhook(body);
    return { received: true };
  }
}
