import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  addressSchema,
  createOrderSchema,
  planAllows,
  tabItemsSchema,
  usesRazorpay,
  type CreateOrderInput,
  type TabItemsInput,
} from '@dinedirect/shared';
import { z } from 'zod';
import { isMissingPlanColumn } from '../../common/plan/plan.util';
import { Public, TenantId } from '../../common/auth/decorators';
import type { AuthedRequest } from '../../common/auth/request-context';
import {
  OptionalCustomerGuard,
  type CustomerAuthedRequest,
} from '../../common/auth/optional-customer.guard';
import { PublicTenantGuard } from '../../common/auth/public-tenant.guard';
import { CustomerAccountService } from '../customers/customer-account.service';

/** The signed result Razorpay Checkout hands back to the browser on success. */
const razorpayVerifySchema = z.object({
  razorpayPaymentId: z.string().min(3).max(120),
  razorpaySignature: z.string().min(3).max(256),
});

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
import { AddressAutocompleteService } from '../delivery/address-autocomplete.service';
import { DeliveryService } from '../delivery/delivery.service';
import { RoutingService } from '../delivery/routing.service';
import { MenuService } from '../menu/menu.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { RazorpayService } from '../payments/razorpay.service';
import { PromotionsService } from '../promotions/promotions.service';
import { RestaurantsService } from '../restaurants/restaurants.service';

const promoPreviewSchema = z.object({
  items: z.array(
    z.object({
      productId: z.string(),
      lineTotalCents: z.number().int().min(0),
    }),
  ),
  code: z.string().max(40).optional(),
});

const quoteSchema = z.object({
  address: addressSchema,
  orderValueCents: z.number().int().min(0),
});

/**
 * `session` is a Google Places session token minted by the client. It groups every
 * keystroke of one address search plus the final details call into ONE billable
 * unit; without it Google bills per keystroke. It is opaque to us — we only pass it
 * through — so any non-empty string is acceptable.
 */
const suggestSchema = z.object({
  q: z.string().min(1).max(200),
  session: z.string().min(1).max(100),
});

const resolveSchema = z.object({
  id: z.string().min(1).max(400),
  session: z.string().min(1).max(100),
});

/** "lat,lng" as the courier map sends it. Kept as a string so both come in one query param. */
const pointSchema = z
  .string()
  .regex(/^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/, 'expected "lat,lng"');

const routeSchema = z.object({
  from: pointSchema,
  to: pointSchema,
});

function parsePoint(raw: string): { latitude: number; longitude: number } {
  const [lat, lng] = raw.split(',').map(Number);
  return { latitude: lat, longitude: lng };
}

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
    private readonly razorpay: RazorpayService,
    private readonly delivery: DeliveryService,
    private readonly routing: RoutingService,
    private readonly addresses: AddressAutocompleteService,
    private readonly prisma: PrismaService,
    private readonly accounts: CustomerAccountService,
    private readonly promotions: PromotionsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The courier map's basemap key, delivered at RUNTIME.
   *
   * Read from the API's MAPTILER_KEY env so a self-host gets crisp MapTiler tiles by
   * setting one env var and restarting the API — no web rebuild. This sidesteps
   * NEXT_PUBLIC_MAPTILER_KEY, which only takes effect if it was set when the web
   * bundle was built (the footgun that made "I set the key but the map didn't change"
   * a recurring surprise). Null → the map falls back to the free CARTO tiles.
   */
  @Get('map-config')
  mapConfig() {
    return { maptilerKey: this.config.get<string>('MAPTILER_KEY') ?? null };
  }

  /** Homepage: branding, hours, whether they're open right now. */
  @Get('restaurant')
  async restaurant(@TenantId() restaurantId: string, @Req() req: AuthedRequest) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { slug: true },
    });
    // The guard only sets isPreviewRequest after validating a staff-minted token,
    // so "loosen the published filter" is scoped to exactly this request.
    return this.restaurants.findPublicBySlug(restaurant.slug, {
      preview: Boolean(req.isPreviewRequest),
    });
  }

  /** The menu. Redis-cached; available items only. */
  @Get('menu')
  menuForRestaurant(@TenantId() restaurantId: string) {
    return this.menu.getPublicMenu(restaurantId);
  }

  /**
   * The cart's "how much does this save me" preview -- the exact same resolution
   * the real order uses at checkout, so a code that previews here can never fail
   * silently at checkout with a different number.
   */
  @Post('promotions/preview')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async previewPromotion(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(promoPreviewSchema)) body: z.infer<typeof promoPreviewSchema>,
  ) {
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { currency: true },
    });
    const discount = await this.promotions.resolveDiscount(
      restaurantId,
      body.items,
      body.code,
      restaurant.currency,
    );
    return { discountCents: discount?.discountCents ?? 0 };
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
      select: {
        uberDirectEnabled: true,
        doorDashEnabled: true,
        deliveryEnabled: true,
        deliveryFeeCents: true,
      },
    });

    if (!restaurant.deliveryEnabled) {
      return { deliverable: false as const, reason: 'This restaurant does not deliver' };
    }

    // Defense in depth: the plan is the source of truth, so a restaurant whose plan
    // doesn't include delivery isn't deliverable even if its flag is still on.
    // Resilient: a missing plan column (pre-migration) leaves delivery as-is.
    try {
      const p = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { planTier: true },
      });
      if (p && !planAllows(p.planTier, 'DELIVERY')) {
        return { deliverable: false as const, reason: 'This restaurant does not deliver' };
      }
    } catch (err) {
      if (!isMissingPlanColumn(err)) throw err;
    }

    // Delivery with no courier at all: the restaurant drives it themselves, so it's a
    // flat fee and always "deliverable" — they know their own range.
    if (!restaurant.uberDirectEnabled && !restaurant.doorDashEnabled) {
      return {
        deliverable: true as const,
        customerFeeCents: restaurant.deliveryFeeCents,
        courierFeeCents: null,
        selfDelivery: true as const,
      };
    }

    return this.delivery.getQuote(restaurantId, body.address, body.orderValueCents);
  }

  /**
   * Address autocomplete, as the customer types.
   *
   * The country is taken from the RESTAURANT, never from the caller. It scopes the
   * provider search, and letting an anonymous caller choose it would turn this into
   * a free worldwide geocoder running on our API key.
   *
   * Throttled tighter than the quote endpoint because it fires per keystroke (the
   * client debounces, but we do not get to rely on a client we don't control), and
   * every call that reaches a provider is billable.
   */
  @Get('address/suggest')
  @Throttle({ default: { limit: 40, ttl: 60_000 } })
  async addressSuggest(
    @TenantId() restaurantId: string,
    @Query(new ZodValidationPipe(suggestSchema)) query: z.infer<typeof suggestSchema>,
  ) {
    if (!this.addresses.available) {
      // No provider key configured. Say so plainly so the checkout form can render a
      // manual address entry instead of a picker that would silently never suggest.
      return { available: false as const, suggestions: [] };
    }

    const { country } = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { country: true },
    });

    return {
      available: true as const,
      suggestions: await this.addresses.suggest(query.q, country, query.session),
    };
  }

  /**
   * Turn the suggestion the customer clicked into a full, geocoded address.
   *
   * Returns `null` when the suggestion has expired or is unknown. The client must
   * then keep whatever the customer typed — quietly blanking their address because
   * our cache dropped an entry would be far worse than an unverified one.
   */
  @Get('address/resolve')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async addressResolve(
    @Query(new ZodValidationPipe(resolveSchema)) query: z.infer<typeof resolveSchema>,
  ) {
    return { address: await this.addresses.resolve(query.id, query.session) };
  }

  /**
   * The road-following driving geometry for the courier map.
   *
   * Proxied through us rather than called from the browser so the route reliably
   * follows the streets: the public routing server rate-limits per-IP browser
   * traffic, which is what left the tracking map drawing a straight line "flying"
   * over the roads. Server-side it's one cached call per leg. Returns `null`
   * geometry when no route is available, and the map falls back to a straight line.
   */
  @Get('route')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async route(
    @TenantId() restaurantId: string,
    @Query(new ZodValidationPipe(routeSchema)) query: z.infer<typeof routeSchema>,
  ) {
    // The restaurant's country picks the regional OSRM in a multi-country deployment.
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { country: true },
    });
    const geometry = await this.routing.route(parsePoint(query.from), parsePoint(query.to), {
      country: restaurant?.country,
    });
    return { geometry };
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

    const base = {
      orderId: order.id,
      orderNumber: order.orderNumber,
      // The customer's key to the tracking page. Unguessable by design.
      trackingToken: order.trackingToken,
      totalCents: order.totalCents,
      currency: order.currency,
    };

    // Pay-at-desk: the order is already placed and cooking; no online payment is
    // collected. Return no checkout URL — the client jumps straight to the tracker and
    // the customer settles at the counter. (The service has already validated this is a
    // genuine dine-in table order; a spoofed flag on a pickup order was dropped there.)
    if (order.payAtDesk) {
      return { ...base, payAtDesk: true, payment: { provider: 'AT_DESK' as const } };
    }

    // Which rail collects is decided by the restaurant's country: India pays through
    // Razorpay's Checkout modal, everyone else through Stripe's hosted redirect. The
    // browser branches on `payment.provider`.
    const restaurant = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { country: true },
    });
    if (usesRazorpay(restaurant.country)) {
      const razorpay = await this.razorpay.createRouteOrder(order.id);
      return { ...base, payment: razorpay };
    }

    const { checkoutUrl } = await this.payments.createCheckoutSession(order.id);
    // `checkoutUrl` stays top-level for backward compatibility; `payment` is the new
    // provider-tagged shape the client should prefer.
    return { ...base, checkoutUrl, payment: { provider: 'STRIPE' as const, checkoutUrl } };
  }

  /**
   * Confirm a Razorpay payment the browser just completed. Razorpay Checkout hands
   * the signed result back to the page, which posts it here; we verify the signature
   * and mark the order paid. (For Stripe this happens via webhook; Razorpay's modal
   * returns to the client, so the client drives confirmation.)
   */
  @Post('orders/:orderId/razorpay/verify')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  verifyRazorpay(
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(razorpayVerifySchema)) body: z.infer<typeof razorpayVerifySchema>,
  ) {
    return this.razorpay.verifyAndCapture({
      orderId,
      razorpayPaymentId: body.razorpayPaymentId,
      razorpaySignature: body.razorpaySignature,
    });
  }

  /**
   * The public "now serving" board -- a TV by the counter, or a QR/link a
   * pickup or dine-in customer scans to watch their own order. Tenant-scoped
   * like every other storefront route; carries no customer PII (see
   * OrdersService.listStatusBoard).
   */
  @Get('order-status-board')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  statusBoard(@TenantId() restaurantId: string) {
    return this.orders.listStatusBoard(restaurantId);
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
   * "Does this table already have a tab running?" — asked when a customer re-scans the
   * table QR after their first order. If there's an open, unpaid dine-in order for the
   * table, we return it so the storefront can offer "add to your table's order" instead
   * of opening a second ticket. Returns null when the table is clear.
   */
  @Get('open-tab')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async openTab(@TenantId() restaurantId: string, @Query('tableNumber') tableNumber?: string) {
    if (!tableNumber) return { tab: null };
    const tab = await this.orders.findOpenTabForTable(restaurantId, tableNumber);
    if (!tab) return { tab: null };
    // Trimmed for a shared-table scanner: only what the "add to this tab?" prompt needs,
    // plus the starter's FIRST name so a different party can tell it isn't theirs and
    // start their own bill. No phone/email/full name — this endpoint answers to anyone
    // holding the table QR.
    return {
      tab: {
        id: tab.id,
        orderNumber: tab.orderNumber,
        trackingToken: tab.trackingToken,
        tableNumber: tab.tableNumber,
        status: tab.status,
        totalCents: tab.totalCents,
        currency: tab.currency,
        customerFirstName: tab.customerName?.trim().split(/\s+/)[0] || null,
        items: tab.items.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          totalCents: i.totalCents,
        })),
      },
    };
  }

  /**
   * A customer at the table adding another round to their open tab. Appends to the same
   * order (one bill for the table). The service refuses anything that isn't a still-open,
   * unpaid dine-in order, so this can only ever grow a live tab — never a settled one.
   */
  @Post('orders/:orderId/tab-items')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  addTabItems(
    @TenantId() restaurantId: string,
    @Param('orderId') orderId: string,
    @Body(new ZodValidationPipe(tabItemsSchema)) body: TabItemsInput,
  ) {
    return this.orders.addTabItems(restaurantId, orderId, body, { source: 'customer' });
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
