import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  addressSchema,
  createOrderSchema,
  widgetEventSchema,
  type CreateOrderInput,
  type WidgetEventInput,
} from '@dinedirect/shared';
import { z } from 'zod';
import { Public } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeliveryService } from '../delivery/delivery.service';
import { MenuService } from '../menu/menu.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { RestaurantsService } from '../restaurants/restaurants.service';
import { WidgetAnalyticsService } from './widget-analytics.service';
import { WidgetService } from './widget.service';
import { WidgetTenantGuard, type WidgetRequest } from './widget-tenant.guard';

const lookupSchema = z.object({
  orderNumber: z.string().min(3).max(20),
  phone: z.string().min(7).max(20),
});

const quoteSchema = z.object({
  address: addressSchema,
  orderValueCents: z.number().int().min(0),
});

/**
 * A widget order is a normal order plus the browser's session id, which is what
 * lets us close the analytics funnel (this session saw the button → this session
 * paid). Intersection rather than `.extend()`: createOrderSchema carries a
 * `.refine()` (delivery orders need an address), so it is a ZodEffects and has no
 * `.extend`. An intersection keeps that refinement intact — dropping it would
 * silently let a widget place a delivery order with no address.
 */
const widgetOrderSchema = createOrderSchema.and(
  z.object({ sessionId: z.string().min(8).max(64) }),
);

/**
 * The API surface the embedded widget talks to, from a third-party website.
 *
 * Mirrors StorefrontController, but the tenant is resolved from (widgetKey,
 * Origin) rather than a subdomain — see WidgetTenantGuard. It is a separate
 * controller rather than a flag on the existing one because the two have
 * genuinely different auth, different CORS, and different rate limits, and
 * merging them would mean a bug in one silently becoming a bug in both.
 */
@ApiTags('widget')
@Controller('widget')
@Public()
@UseGuards(WidgetTenantGuard)
export class WidgetPublicController {
  constructor(
    private readonly widget: WidgetService,
    private readonly analytics: WidgetAnalyticsService,
    private readonly restaurants: RestaurantsService,
    private readonly menu: MenuService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly delivery: DeliveryService,
    private readonly prisma: PrismaService,
  ) {}

  /** Branding + settings + open/closed. One round trip before the button paints. */
  @Get('config')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async config(@Req() req: WidgetRequest) {
    const { integrationId, restaurantId } = req.widget!;

    const [config, restaurant] = await Promise.all([
      this.widget.getPublicConfig(integrationId),
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: restaurantId },
        select: { slug: true },
      }),
    ]);

    const storefront = await this.restaurants.findPublicBySlug(restaurant.slug);

    return {
      settings: config.settings,
      restaurant: storefront,
    };
  }

  @Get('menu')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  menu_(@Req() req: WidgetRequest) {
    return this.menu.getPublicMenu(req.widget!.restaurantId);
  }

  @Post('delivery-quote')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async deliveryQuote(
    @Req() req: WidgetRequest,
    @Body(new ZodValidationPipe(quoteSchema)) body: z.infer<typeof quoteSchema>,
  ) {
    const { restaurantId } = req.widget!;

    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { uberDirectEnabled: true, deliveryEnabled: true, deliveryFeeCents: true },
    });

    if (!restaurant.deliveryEnabled) {
      return { deliverable: false as const, reason: 'This restaurant does not deliver' };
    }
    if (!restaurant.uberDirectEnabled) {
      return {
        deliverable: true as const,
        customerFeeCents: restaurant.deliveryFeeCents,
        uberFeeCents: null,
        selfDelivery: true as const,
      };
    }

    return this.delivery.getQuote(restaurantId, body.address, body.orderValueCents);
  }

  /**
   * Place an order from the widget.
   *
   * Identical pricing path to the storefront — the client sends ids, the server
   * prices it. The only difference is that we stamp the integration onto the
   * order, which is what lets the dashboard say "this website earned you £4,200".
   */
  @Post('orders')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async createOrder(
    @Req() req: WidgetRequest,
    @Body(new ZodValidationPipe(widgetOrderSchema))
    body: CreateOrderInput & { sessionId: string },
  ) {
    const { integrationId, restaurantId, origin } = req.widget!;

    const order = await this.orders.create(restaurantId, body);

    await this.prisma.order.update({
      where: { id: order.id },
      data: { websiteIntegrationId: integrationId },
    });

    const { checkoutUrl } = await this.payments.createCheckoutSession(order.id);

    void this.analytics.record({
      integrationId,
      restaurantId,
      type: 'ORDER_CREATED',
      sessionId: body.sessionId,
      origin,
      orderId: order.id,
    });

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      trackingToken: order.trackingToken,
      totalCents: order.totalCents,
      currency: order.currency,
      /**
       * The host page opens this in a NEW TAB. Stripe sets frame-ancestors, so
       * Checkout cannot render inside our iframe — and redirecting the top window
       * would navigate the customer off the restaurant's site, which is the one
       * thing this whole module exists to prevent.
       *
       * The widget is Stripe-only: Razorpay's modal can't open cross-origin inside a
       * third-party iframe, so an India restaurant collects widget orders through its
       * main storefront instead. (createCheckoutSession already rejects a restaurant
       * that can't take Stripe, so this fails loudly rather than silently.)
       */
      checkoutUrl,
      payment: { provider: 'STRIPE' as const, checkoutUrl },
    };
  }

  /**
   * Poll an order while the customer pays in the other tab. The widget switches
   * to its tracking view the moment this reports PAID.
   */
  @Get('orders/:token')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  track(@Param('token') token: string) {
    return this.orders.findByTrackingToken(token);
  }

  /**
   * A customer finding an order they already placed, from inside the widget.
   *
   * They closed the widget mid-delivery, or lost the SMS. Without this their only
   * route back is leaving the restaurant's website — which is precisely the thing
   * this whole module exists to prevent.
   *
   * Order number AND phone, and throttled to 5/minute per IP: order numbers are
   * sequential, so a number-only lookup would let anyone walk the list and read
   * strangers' orders and delivery addresses.
   */
  @Post('lookup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  lookup(
    @Req() req: WidgetRequest,
    @Body(new ZodValidationPipe(lookupSchema)) body: z.infer<typeof lookupSchema>,
  ) {
    return this.orders.lookupForCustomer(
      req.widget!.restaurantId,
      body.orderNumber,
      body.phone,
    );
  }

  /** Funnel telemetry. Deduplicated per session server-side. */
  @Post('events')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async event(
    @Req() req: WidgetRequest,
    @Body(new ZodValidationPipe(widgetEventSchema)) body: WidgetEventInput,
  ): Promise<void> {
    const { integrationId, restaurantId, origin } = req.widget!;

    await this.analytics.record({
      integrationId,
      restaurantId,
      type: body.type,
      sessionId: body.sessionId,
      origin,
    });

    // A VIEW is proof the snippet is live on the real site. Stamp the install.
    if (body.type === 'VIEW') {
      void this.widget.touchInstalled(integrationId);
    }
  }
}
