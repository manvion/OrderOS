import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { addressSchema, createOrderSchema, type CreateOrderInput } from '@orderos/shared';
import { z } from 'zod';
import { Public, TenantId } from '../../common/auth/decorators';
import {
  OptionalCustomerGuard,
  type CustomerAuthedRequest,
} from '../../common/auth/optional-customer.guard';
import { PublicTenantGuard } from '../../common/auth/public-tenant.guard';
import { CustomerAccountService } from '../customers/customer-account.service';

/** Order number + the phone that placed it. Both, or nothing. */
const lookupSchema = z.object({
  orderNumber: z.string().min(3).max(20),
  phone: z.string().min(7).max(20),
});

/** A saved address is a delivery address plus the human bits that make it usable. */
const saveAddressSchema = addressSchema.extend({
  label: z.string().max(40).optional(),
  /** Buzzer codes, gate instructions — what actually determines a successful drop. */
  notes: z.string().max(280).optional(),
  isDefault: z.boolean().optional(),
});
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeliveryService } from '../delivery/delivery.service';
import { MenuService } from '../menu/menu.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { RestaurantsService } from '../restaurants/restaurants.service';

const quoteSchema = z.object({
  address: addressSchema,
  orderValueCents: z.number().int().min(0),
});

/**
 * Everything a customer's browser talks to. No Clerk session — the tenant is
 * resolved from the subdomain by PublicTenantGuard, and only published,
 * active restaurants resolve at all.
 */
@ApiTags('storefront')
@Controller('storefront')
@Public()
@UseGuards(PublicTenantGuard)
export class StorefrontController {
  constructor(
    private readonly restaurants: RestaurantsService,
    private readonly menu: MenuService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly delivery: DeliveryService,
    private readonly prisma: PrismaService,
    private readonly accounts: CustomerAccountService,
  ) {}

  /** Homepage: branding, hours, whether they're open right now. */
  @Get('restaurant')
  async restaurant(@TenantId() restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { slug: true },
    });
    return this.restaurants.findPublicBySlug(restaurant.slug);
  }

  /** The menu. Redis-cached; available items only. */
  @Get('menu')
  menuForRestaurant(@TenantId() restaurantId: string) {
    return this.menu.getPublicMenu(restaurantId);
  }

  /**
   * Can we deliver here, and what will it cost?
   *
   * Called from the checkout page as the customer types their address. Throttled
   * hard: each call hits Uber's API, and an unthrottled endpoint here is a way to
   * burn our Uber rate limit (and money) for free.
   */
  @Post('delivery-quote')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async deliveryQuote(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(quoteSchema)) body: z.infer<typeof quoteSchema>,
  ) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { uberDirectEnabled: true, deliveryEnabled: true, deliveryFeeCents: true },
    });

    if (!restaurant.deliveryEnabled) {
      return { deliverable: false as const, reason: 'This restaurant does not deliver' };
    }

    // Delivery without Uber: the restaurant drives it themselves, so it's a flat
    // fee and always "deliverable" — they know their own range.
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
   * Place an order and get a Stripe Checkout URL back.
   *
   * The two steps are deliberately one endpoint: an order that exists without a
   * checkout session is an order the customer can never pay for, and it would sit
   * on the restaurant's books forever.
   *
   * Rate limited per IP — order creation writes to the DB and calls Stripe, so
   * it's the most expensive thing an anonymous caller can do.
   */
  @Post('orders')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  // Optional: a guest and a signed-in customer take the SAME path through here.
  // Being signed in only means the order gets attached to their account, so it
  // shows up in their history and their address is offered back next time.
  @UseGuards(OptionalCustomerGuard)
  async createOrder(
    @TenantId() restaurantId: string,
    @Req() req: CustomerAuthedRequest,
    @Body(new ZodValidationPipe(createOrderSchema)) body: CreateOrderInput,
  ) {
    const order = await this.orders.create(restaurantId, body, req.customerClerkUserId);
    const { checkoutUrl } = await this.payments.createCheckoutSession(order.id);

    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      // The customer's key to the tracking page. Unguessable by design.
      trackingToken: order.trackingToken,
      totalCents: order.totalCents,
      currency: order.currency,
      checkoutUrl,
    };
  }

  /**
   * Order tracking. Keyed by the tracking token, not the order id, so the link we
   * text someone can't be incremented into reading a stranger's order.
   *
   * Not tenant-guarded on purpose — the token IS the authorization.
   */
  @Get('track/:token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  track(@Param('token') token: string) {
    return this.orders.findByTrackingToken(token);
  }

  /**
   * "I closed the tab. Where's my food?"
   *
   * A guest has no account and may have lost the SMS. Without this, their only
   * route back to their own order is a phone call to a kitchen that is busy
   * cooking it — which is a bad experience for both of them.
   *
   * Requires order number AND the phone number that placed it. Neither alone is
   * enough: order numbers are short and sequential (0712-014), so a lookup by
   * number alone would let anyone read any stranger's order by counting. The phone
   * number is the thing only the actual customer knows.
   *
   * Throttled hard, per IP, because this is the one endpoint on the platform that
   * takes a guessable identifier — 5/minute makes enumeration pointless while
   * still being invisible to a real customer who mistyped once.
   */
  @Post('lookup')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  lookup(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(lookupSchema)) body: z.infer<typeof lookupSchema>,
  ) {
    return this.orders.lookupForCustomer(restaurantId, body.orderNumber, body.phone);
  }

  // --- Customer accounts -----------------------------------------------------
  //
  // Optional, always. Every route above works perfectly for a guest, and these
  // exist only to remove typing for someone who chose to sign up. If a customer
  // never creates an account, they lose nothing except the convenience.

  /** Profile, saved addresses, recent orders. 401 only if they aren't signed in. */
  @Get('me')
  @UseGuards(OptionalCustomerGuard)
  async me(@TenantId() restaurantId: string, @Req() req: CustomerAuthedRequest) {
    if (!req.customerClerkUserId) {
      throw new UnauthorizedException('Not signed in');
    }
    return this.accounts.getProfile(restaurantId, req.customerClerkUserId);
  }

  @Post('me/addresses')
  @UseGuards(OptionalCustomerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async addAddress(
    @TenantId() restaurantId: string,
    @Req() req: CustomerAuthedRequest,
    @Body(new ZodValidationPipe(saveAddressSchema)) body: z.infer<typeof saveAddressSchema>,
  ) {
    if (!req.customerClerkUserId) throw new UnauthorizedException('Sign in to save an address');
    return this.accounts.addAddress(restaurantId, req.customerClerkUserId, body);
  }

  @Delete('me/addresses/:id')
  @UseGuards(OptionalCustomerGuard)
  async deleteAddress(
    @TenantId() restaurantId: string,
    @Req() req: CustomerAuthedRequest,
    @Param('id') id: string,
  ) {
    if (!req.customerClerkUserId) throw new UnauthorizedException('Not signed in');
    await this.accounts.deleteAddress(restaurantId, req.customerClerkUserId, id);
    return { success: true };
  }
}
