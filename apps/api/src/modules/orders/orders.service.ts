import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { OrderStatus, Prisma, Restaurant } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import {
  canTransition,
  generateHandoffCode,
  isOpenAt,
  planAllows,
  priceOrder,
  type PlanTier,
  type TaxComponent,
  type BusinessHours,
  type CreateOrderInput,
  type PricedLineItem,
} from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  effectiveCommissionBps,
  isMissingPlanColumn,
  PLAN_DB_COLUMNS,
} from '../../common/plan/plan.util';
import { applyInventoryDelta } from '../../common/inventory/inventory.util';
import { recordCashMovement } from '../../common/cash/cash.util';
import { applyLoyaltyDelta, pointsForSubtotal } from '../../common/loyalty/loyalty.util';
import { AuditService } from '../../common/audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CourierRouter } from '../delivery/courier.router';
import { GeocodingService } from '../delivery/geocoding.service';
import { PromotionsService } from '../promotions/promotions.service';

export interface ListOrdersOptions {
  status?: OrderStatus[];
  /** Dashboard default: hide orders whose payment never landed. */
  paidOnly?: boolean;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

/** A staff-entered walk-in or phone order, paid in person. See createWalkIn. */
export interface WalkInOrderInput {
  items: Array<{ productId: string; quantity: number; notes?: string; modifierIds: string[] }>;
  fulfillment: 'PICKUP' | 'DINE_IN' | 'DELIVERY';
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  tableNumber?: string;
  /** Required when fulfillment is DELIVERY — where the phone order is going. */
  deliveryAddress?: {
    street: string;
    city: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  paymentMethod: 'CASH' | 'CARD_TERMINAL';
  /**
   * Create the order UNPAID and let the Terminal (Tap to Pay) charge it, instead of
   * marking it paid on the honour system. Pickup / dine-in only -- a card the counter
   * already ran elsewhere still uses the paid-in-person path. See createWalkIn.
   */
  deferPayment?: boolean;
  notes?: string;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    // The delivery radius gate. Geocoding depends on nothing, so injecting it here
    // does not deepen the Orders <-> Delivery cycle.
    private readonly geocoding: GeocodingService,
    // Prices the courier at order time so the cost is recouped inside the charge.
    private readonly couriers: CourierRouter,
    private readonly promotions: PromotionsService,
  ) {}

  /**
   * Load the restaurant a new order is placed against — resiliently.
   *
   * Order creation reads the whole restaurant row, which selects the subscription
   * columns. If that migration hasn't been applied in this environment, the first
   * read throws and we retry omitting those columns, so a lagging migration can
   * NEVER stop a restaurant taking orders. The plan-derived bits (loyalty gating)
   * fail open when the columns are absent — see loyaltyAllowedByPlan.
   */
  private async loadRestaurantForOrder(
    where: Prisma.RestaurantWhereInput,
  ): Promise<Restaurant | null> {
    try {
      return await this.prisma.restaurant.findFirst({ where });
    } catch (err) {
      if (!isMissingPlanColumn(err)) throw err;
      this.logger.error(
        'Restaurant plan columns missing — run `npx prisma migrate deploy`. Taking the ' +
          'order without plan-derived gating until then.',
      );
      // The omitted plan fields are absent at runtime; loyaltyAllowedByPlan reads
      // planTier defensively and fails open, so the cast is safe.
      return (await this.prisma.restaurant.findFirst({
        where,
        omit: PLAN_DB_COLUMNS,
      })) as Restaurant | null;
    }
  }

  /**
   * Does the restaurant's PLAN allow earning loyalty on this order? The plan is the
   * source of truth: a restaurant that ticked loyalty on before it was on a plan
   * that includes it must not still accrue points. Fails open (allows) when the
   * plan column is absent, i.e. the migration hasn't run here yet.
   */
  private loyaltyAllowedByPlan(restaurant: object): boolean {
    const tier = (restaurant as { planTier?: PlanTier | null }).planTier;
    return !tier || planAllows(tier, 'LOYALTY');
  }

  /**
   * Create an order from a customer's cart.
   *
   * The cart contains product ids and modifier ids — NO prices. Every price is
   * re-read from the database here and the total is recomputed with the shared
   * pricing engine. A malicious client that posts a $0.01 lobster gets billed
   * for a lobster.
   *
   * The order lands in PENDING with an unpaid Payment. It does not appear on the
   * restaurant's board until Stripe confirms the charge (see PaymentsService) —
   * kitchens should never start cooking against an unpaid ticket.
   */
  async create(restaurantId: string, input: CreateOrderInput, clerkUserId?: string) {
    const restaurant = await this.loadRestaurantForOrder({
      id: restaurantId,
      isPublished: true,
      isActive: true,
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    this.assertFulfillmentAllowed(restaurant, input);
    const scheduledFor = this.resolveSchedule(restaurant, input);

    // ASAP orders require the restaurant to be open right now. Scheduled orders
    // don't — that's the entire point of scheduling.
    if (!scheduledFor) {
      const hours = restaurant.businessHours as unknown as BusinessHours;
      if (!isOpenAt(hours, restaurant.timezone)) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'RestaurantClosed',
          message: `${restaurant.name} is closed right now`,
        });
      }
    }

    /**
     * The delivery radius, enforced at ORDER CREATION — not only at the quote.
     *
     * The quote is a courtesy to the browser. This is the gate. A client that never
     * calls the quote endpoint, or that ignores its answer, must still be refused —
     * otherwise the radius is a suggestion, and the first person to open devtools
     * gets their food delivered from 40km away while the restaurant eats the courier
     * fee.
     *
     * If geocoding is unavailable we DO NOT block the order. Uber still has to
     * accept the delivery, and failing a paying customer's dinner because our
     * geocoder had a bad afternoon would be us breaking a restaurant's business over
     * our own outage.
     */
    if (input.fulfillment === 'DELIVERY' && input.deliveryAddress) {
      const radius = await this.geocoding.checkRadius(restaurant, input.deliveryAddress);

      if (radius && !radius.withinRadius) {
        const km = (radius.distanceMeters / 1000).toFixed(1);
        const limitKm = (restaurant.deliveryRadiusMeters / 1000).toFixed(1);

        throw new BadRequestException({
          statusCode: 400,
          error: 'OutOfDeliveryRange',
          message: `That address is ${km}km away — outside ${restaurant.name}'s ${limitKm}km delivery range. Choose pickup instead, or call them.`,
          distanceMeters: radius.distanceMeters,
          limitMeters: restaurant.deliveryRadiusMeters,
        });
      }
    }

    const lineItems = await this.resolveLineItems(restaurantId, input);

    // The declared value a courier insures the food for -- needed BEFORE the
    // delivery fee is known, since the fee itself comes from this same quote.
    // Goods only: tax and tip have nothing to do with what a courier is carrying.
    const pricedItemsForPromo = lineItems.map((item) => ({
      productId: item.productId,
      lineTotalCents:
        (item.unitPriceCents + item.modifiers.reduce((s, m) => s + m.priceCents, 0)) * item.quantity,
    }));
    const goodsValueCents = pricedItemsForPromo.reduce((sum, item) => sum + item.lineTotalCents, 0);

    /**
     * Price the courier NOW, before pricing the order -- the customer is charged
     * this exact fee (see DeliveryService.getQuote, which shows the same number at
     * checkout preview time). The platform's own courier account pays Uber/DoorDash
     * for every dispatch; application_fee_amount (see PaymentsService) recovers
     * precisely this amount from the restaurant's payout, so charging the customer
     * anything else would make delivery a source of restaurant profit or loss
     * instead of a clean pass-through. Failure here must never block a paying
     * customer: no quote means the platform absorbs this one dispatch (the
     * customer falls back to the restaurant's flat self-delivery rate), logged,
     * not thrown.
     *
     * Independent of the customer upsert and the order-number count -- run all
     * three concurrently rather than paying for Uber/DoorDash's round-trip, THEN
     * the upsert, THEN the count, one after another. Checkout latency used to be
     * their sum; it is now whichever one is slowest.
     */
    const courierQuote =
      input.fulfillment === 'DELIVERY' &&
      input.deliveryAddress &&
      (restaurant.uberDirectEnabled || restaurant.doorDashEnabled)
        ? this.couriers
            .bestQuote(restaurant, {
              pickup: restaurant,
              dropoff: input.deliveryAddress,
              pickupReadyAt: new Date(Date.now() + restaurant.prepTimeMinutes * 60_000),
              orderValueCents: goodsValueCents,
              externalId: `order-quote_${randomBytes(8).toString('hex')}`,
            })
            .then(({ quote }) => quote?.feeCents ?? null)
            .catch((err: Error) => {
              this.logger.warn(
                `Courier quote failed at order time -- platform absorbs this dispatch: ${err.message}`,
              );
              return null;
            })
        : Promise.resolve(null);

    const [courierCostCents, customer, orderNumber, discount] = await Promise.all([
      courierQuote,
      this.upsertCustomer(restaurantId, input.customer, clerkUserId),
      this.nextOrderNumber(restaurantId),
      // Resolved per-item so a promotion scoped to specific products discounts
      // exactly those, not the whole cart. A bad or expired code throws here
      // and fails the order, same as it did in the cart preview.
      this.promotions.resolveDiscount(restaurantId, pricedItemsForPromo, input.promoCode, restaurant.currency),
    ]);

    const pricing = priceOrder({
      items: lineItems,
      taxRateBps: restaurant.taxRateBps,
      // Named components win when present — the only way to charge Quebec
      // (GST + QST) or India (CGST + SGST) correctly, and the only way to print
      // them legally.
      taxComponents: (restaurant.taxComponents as TaxComponent[] | null) ?? undefined,
      taxDeliveryFee: restaurant.taxDeliveryFee,
      fulfillment: input.fulfillment,
      // The courier's real quote. Falls back to the restaurant's flat rate only
      // when there is no quote to reference -- self-delivery, or the quote above
      // failed and the platform is absorbing this dispatch instead.
      deliveryFeeCents: courierCostCents ?? restaurant.deliveryFeeCents,
      serviceFeeCents: restaurant.serviceFeeCents,
      serviceChargeType: restaurant.serviceChargeType,
      serviceChargeCents: restaurant.serviceChargeCents,
      serviceChargeBps: restaurant.serviceChargeBps,
      tipCents: input.tipCents,
      discountCents: discount?.discountCents ?? 0,
    });

    // A minimum order is a DELIVERY floor — it's there to make a driver worth
    // dispatching. Pickup and dine-in have no such cost, so they're never blocked.
    if (input.fulfillment === 'DELIVERY' && pricing.subtotalCents < restaurant.minOrderCents) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'BelowMinimum',
        message: `Minimum delivery order is ${(restaurant.minOrderCents / 100).toFixed(2)} ${restaurant.currency}`,
        minOrderCents: restaurant.minOrderCents,
        subtotalCents: pricing.subtotalCents,
      });
    }

    // Frozen now so a later change to the earn rate can't reprice a promise
    // already implied by this checkout. NOT credited to the customer yet --
    // that happens only once Stripe confirms payment (see PaymentsService).
    const loyaltyPointsEarned =
      restaurant.loyaltyEnabled && this.loyaltyAllowedByPlan(restaurant)
        ? pointsForSubtotal(pricing.subtotalCents, restaurant.loyaltyPointsPerDollar)
        : 0;

    // Pay-at-desk is only ever offered for a dine-in order placed from a table QR --
    // it's the sit-down "put it on the table, I'll settle when I leave" flow. We never
    // let a pickup/delivery customer walk off with unpaid food, so the flag is dropped
    // unless the order really is a table dine-in.
    const payAtDesk =
      input.payAtDesk === true && input.fulfillment === 'DINE_IN' && !!input.tableNumber;

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber,
          // The code that gets the right food to the right person, on EVERY order —
          // read out at a counter, printed next to a table number, or matched against
          // a bag by a courier. See packages/shared/src/handoff.ts.
          handoffCode: generateHandoffCode((n) => randomBytes(n)),
          restaurantId,
          customerId: customer.id,
          // Every new ticket starts PENDING (a new order the kitchen must accept). A
          // pay-at-desk order is no different in status — what makes it show on the
          // board despite being unpaid is the payAtDesk flag, which listActive ORs in.
          status: 'PENDING',
          payAtDesk,
          fulfillment: input.fulfillment,

          subtotalCents: pricing.subtotalCents,
          taxCents: pricing.taxCents,
          deliveryFeeCents: pricing.deliveryFeeCents,
          serviceFeeCents: pricing.serviceFeeCents,
          serviceChargeCents: pricing.serviceChargeCents,
          serviceChargeLabel: restaurant.serviceChargeLabel,
          tipCents: pricing.tipCents,
          discountCents: pricing.discountCents,
          promotionId: discount?.promotionId,
          totalCents: pricing.totalCents,
          currency: restaurant.currency,
          taxRateBps: restaurant.taxRateBps,
          // Frozen at checkout. A tax audit reads THIS, not today's settings — and a
          // rate change must never rewrite a receipt that has already been issued.
          taxLines: pricing.taxLines as unknown as Prisma.InputJsonValue,
          loyaltyPointsEarned,

          customerName: input.customer.name,
          customerPhone: input.customer.phone,
          customerEmail: input.customer.email,
          locale: input.locale,

          ...(input.deliveryAddress
            ? {
                deliveryStreet: input.deliveryAddress.street,
                deliveryCity: input.deliveryAddress.city,
                deliveryState: input.deliveryAddress.state,
                deliveryPostalCode: input.deliveryAddress.postalCode,
                deliveryCountry: input.deliveryAddress.country,
                deliveryLatitude: input.deliveryAddress.latitude,
                deliveryLongitude: input.deliveryAddress.longitude,
              }
            : {}),

          notes: input.notes,
          tableNumber: input.tableNumber,
          qrCodeId: input.qrCodeId,
          scheduledFor,

          items: {
            create: lineItems.map((item) => {
              const modifiersCents = item.modifiers.reduce((s, m) => s + m.priceCents, 0);
              return {
                name: item.name,
                quantity: item.quantity,
                unitPriceCents: item.unitPriceCents,
                totalCents: (item.unitPriceCents + modifiersCents) * item.quantity,
                notes: item.notes,
                productId: item.productId,
                modifiers: {
                  create: item.modifiers.map((m) => ({
                    name: m.name,
                    priceCents: m.priceCents,
                    quantity: m.quantity,
                    modifierId: m.modifierId,
                  })),
                },
              };
            }),
          },

          payment: {
            create: payAtDesk
              ? {
                  restaurantId,
                  amountCents: pricing.totalCents,
                  currency: restaurant.currency,
                  // Unpaid until a staff member settles it at the counter. No Stripe
                  // charge exists, so — exactly like a walk-in — there's nothing for an
                  // application fee to take a cut of; the platform earns no commission
                  // on an at-desk sale. Marked CARD_TERMINAL because that's how the
                  // counter will most likely collect; staff aren't billed on the method.
                  status: 'PENDING',
                  method: 'CARD_TERMINAL',
                  platformFeeCents: 0,
                }
              : {
                  restaurantId,
                  amountCents: pricing.totalCents,
                  currency: restaurant.currency,
                  status: 'PENDING',
                  /**
                   * Commission is taken on NET FOOD SALES (subtotal minus discount) — NOT
                   * on the whole total. Taking a cut of sales tax is taking a cut of money
                   * that belongs to the government; taking a cut of the tip is taking it
                   * from the staff; and delivery is largely a pass-through. So the base is
                   * the merchandise the restaurant actually sold, which is also the number
                   * the restaurant reconciles its own commission against.
                   */
                  platformFeeCents: Math.round(
                    ((pricing.subtotalCents - pricing.discountCents) *
                      effectiveCommissionBps(restaurant)) /
                      10_000,
                  ),
                  courierCostCents,
                },
          },

          events: {
            create: {
              status: 'PENDING',
              source: 'customer',
              note: payAtDesk ? 'Order placed — pay at desk' : 'Order placed',
            },
          },
        },
        include: this.orderInclude(),
      });

      // The kitchen is about to cook this, so the stock leaves now — the same point a
      // walk-in decrements. Loyalty is NOT credited yet; that waits until the bill is
      // actually settled at the desk (markOrderPaid handles it), so an abandoned table
      // never banks points.
      if (payAtDesk) await applyInventoryDelta(tx, lineItems, -1);

      return created;
    });

    this.logger.log(`Order ${order.orderNumber} created for ${restaurant.slug}`);

    if (discount) {
      // Informational only -- never blocks the response the customer is waiting on.
      this.promotions
        .recordRedemption(discount.promotionId)
        .catch((err: Error) => this.logger.warn(`Failed to record promotion redemption: ${err.message}`));
    }

    // A pay-at-desk order never touches Stripe, so no webhook will ever fire the
    // "NEW ORDER" alert + printable ticket the kitchen relies on. Fire it here, at
    // creation, the same way markOrderPaid does for a paid order — the kitchen must
    // start cooking now, not when the customer eventually settles the bill.
    if (payAtDesk) {
      void this.notifications.onOrderStatus(order, restaurant, 'PENDING').catch((err) => {
        this.logger.error(`Notification failed for pay-at-desk order ${order.id}: ${(err as Error).message}`);
      });
    }

    return order;
  }

  /**
   * A walk-in or phone order, entered by staff and paid at the counter -- no
   * Stripe checkout, no webhook to wait for. The order is created ALREADY
   * paid, because the money already changed hands the moment staff typed this
   * in; nothing here should wait for a confirmation that is never coming.
   *
   * The one exception is `deferPayment` (pickup / dine-in): a card the counter has
   * NOT yet collected, created UNPAID for the Terminal (Tap to Pay) to charge. It
   * stays off the kitchen board until the tap settles it -- see deferPayment below.
   *
   * Pickup and dine-in only. Delivery needs an online charge to fold the
   * courier's cost into -- "pay the driver cash" is a different feature, not
   * a variant of this one.
   *
   * Deliberately skips the isOpenAt gate the online flow enforces: that check
   * exists to stop a stranger ordering into an empty kitchen. Staff standing
   * at the counter typing this in IS the confirmation the kitchen is open.
   */
  async createWalkIn(restaurantId: string, input: WalkInOrderInput, userId: string) {
    const restaurant = await this.loadRestaurantForOrder({ id: restaurantId, isActive: true });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    this.assertFulfillmentAllowed(restaurant, { fulfillment: input.fulfillment });
    const lineItems = await this.resolveLineItems(restaurantId, { items: input.items });

    /**
     * Tap-to-Pay hand-off: create the order UNPAID and leave the charge to the Terminal
     * (see PaymentsService.createTerminalPaymentIntent / settleTerminalOrder). It then
     * sits in listAwaitingPayment until the tap lands, at which point markOrderPaid does
     * the stock decrement, loyalty credit and the kitchen "NEW ORDER" alert -- so an
     * unpaid card order never reaches the kitchen. Pickup / dine-in only: a delivery
     * order folds the courier cost into its charge, a different path we don't defer here.
     */
    const deferPayment = input.deferPayment === true && input.fulfillment !== 'DELIVERY';

    /**
     * A phone order that's being DELIVERED needs an address — to gate against the
     * restaurant's delivery radius, to geocode for the courier and the tracking map,
     * and a phone to reach the customer on. The radius check fails OPEN on a geocoder
     * outage (same as a customer's own online order): we never block a real order over
     * our own bad afternoon, but we do reject an address that's clearly out of range.
     */
    let deliveryCoords: { latitude: number; longitude: number } | null = null;
    let deliveryFeeCents = 0;
    let deliveryAddress: Required<NonNullable<WalkInOrderInput['deliveryAddress']>> | null = null;

    if (input.fulfillment === 'DELIVERY') {
      if (!input.deliveryAddress?.street?.trim()) {
        throw new BadRequestException('A delivery address is required for a delivery order');
      }
      if (!input.customerPhone?.trim()) {
        throw new BadRequestException('A phone number is required for a delivery order');
      }

      deliveryAddress = {
        street: input.deliveryAddress.street,
        city: input.deliveryAddress.city,
        state: input.deliveryAddress.state ?? '',
        postalCode: input.deliveryAddress.postalCode ?? '',
        country: input.deliveryAddress.country || restaurant.country,
      };

      const radius = await this.geocoding.checkRadius(restaurant, deliveryAddress);
      if (radius && !radius.withinRadius) {
        const km = (radius.distanceMeters / 1000).toFixed(1);
        const limitKm = (restaurant.deliveryRadiusMeters / 1000).toFixed(1);
        throw new BadRequestException(
          `That address is ${km}km away — outside ${restaurant.name}'s ${limitKm}km delivery range.`,
        );
      }

      deliveryCoords = await this.geocoding.geocode(deliveryAddress);
      // The restaurant's flat delivery fee is what the customer pays in person. The
      // actual courier is priced and dispatched later, when staff mark it ready.
      deliveryFeeCents = restaurant.deliveryFeeCents;
    }

    const pricing = priceOrder({
      items: lineItems,
      taxRateBps: restaurant.taxRateBps,
      taxComponents: (restaurant.taxComponents as TaxComponent[] | null) ?? undefined,
      taxDeliveryFee: restaurant.taxDeliveryFee,
      fulfillment: input.fulfillment,
      deliveryFeeCents,
      serviceFeeCents: restaurant.serviceFeeCents,
      serviceChargeType: restaurant.serviceChargeType,
      serviceChargeCents: restaurant.serviceChargeCents,
      serviceChargeBps: restaurant.serviceChargeBps,
      tipCents: 0,
    });

    // No minimum-order check: staff entering a phone order know what they're taking,
    // and the delivery minimum is a self-service guard rail, not a rule for the counter.

    const loyaltyPointsEarned =
      restaurant.loyaltyEnabled && this.loyaltyAllowedByPlan(restaurant)
        ? pointsForSubtotal(pricing.subtotalCents, restaurant.loyaltyPointsPerDollar)
        : 0;

    const customerName = input.customerName?.trim() || 'Walk-in customer';
    const customerPhone = input.customerPhone?.trim() ?? '';
    const customerEmail = input.customerEmail?.trim() ?? '';

    // Only a REAL phone rolls up to a CRM record -- upsertCustomer keys on it,
    // and a blank phone would collide every phone-less walk-in into "the same
    // customer" the moment a second one came in.
    const customer = customerPhone
      ? await this.upsertCustomer(restaurantId, {
          name: customerName,
          phone: customerPhone,
          email: customerEmail,
        })
      : null;

    const orderNumber = await this.nextOrderNumber(restaurantId);
    const now = new Date();

    const order = await this.prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderNumber,
          handoffCode: generateHandoffCode((n) => randomBytes(n)),
          restaurantId,
          customerId: customer?.id,
          status: 'PENDING',
          fulfillment: input.fulfillment,

          subtotalCents: pricing.subtotalCents,
          taxCents: pricing.taxCents,
          deliveryFeeCents: pricing.deliveryFeeCents,
          serviceFeeCents: pricing.serviceFeeCents,
          serviceChargeCents: pricing.serviceChargeCents,
          serviceChargeLabel: restaurant.serviceChargeLabel,
          tipCents: 0,
          discountCents: pricing.discountCents,
          totalCents: pricing.totalCents,
          currency: restaurant.currency,
          taxRateBps: restaurant.taxRateBps,
          taxLines: pricing.taxLines as unknown as Prisma.InputJsonValue,
          loyaltyPointsEarned,

          customerName,
          customerPhone,
          customerEmail,

          notes: input.notes,
          tableNumber: input.tableNumber,

          ...(deliveryAddress
            ? {
                deliveryStreet: deliveryAddress.street,
                deliveryCity: deliveryAddress.city,
                deliveryState: deliveryAddress.state,
                deliveryPostalCode: deliveryAddress.postalCode,
                deliveryCountry: deliveryAddress.country,
                deliveryLatitude: deliveryCoords?.latitude,
                deliveryLongitude: deliveryCoords?.longitude,
              }
            : {}),

          items: {
            create: lineItems.map((item) => {
              const modifiersCents = item.modifiers.reduce((s, m) => s + m.priceCents, 0);
              return {
                name: item.name,
                quantity: item.quantity,
                unitPriceCents: item.unitPriceCents,
                totalCents: (item.unitPriceCents + modifiersCents) * item.quantity,
                notes: item.notes,
                productId: item.productId,
                modifiers: {
                  create: item.modifiers.map((m) => ({
                    name: m.name,
                    priceCents: m.priceCents,
                    quantity: m.quantity,
                    modifierId: m.modifierId,
                  })),
                },
              };
            }),
          },

          payment: {
            create: {
              restaurantId,
              amountCents: pricing.totalCents,
              currency: restaurant.currency,
              // A deferred card order is UNPAID until the Terminal charges it; the tap
              // recomputes and writes the commission at intent time (createTerminalPaymentIntent).
              // A paid-in-person sale never touches the platform's payment rail, so there
              // is nothing for application_fee to take a cut of -- platformFeeCents 0.
              status: deferPayment ? 'PENDING' : 'PAID',
              method: input.paymentMethod,
              platformFeeCents: 0,
              ...(deferPayment ? {} : { paidAt: now }),
            },
          },

          events: {
            create: {
              status: 'PENDING',
              source: 'restaurant',
              note: deferPayment
                ? 'Walk-in order entered by staff — awaiting card (Tap to Pay)'
                : 'Walk-in order entered by staff',
            },
          },
        },
        include: this.orderInclude(),
      });

      // A deferred card order isn't paid yet -- stock, loyalty and the till all wait
      // for the tap (markOrderPaid handles them on settle), exactly like an online order.
      if (deferPayment) return created;

      // Paid the instant staff typed it in -- decrement now, not on some later
      // confirmation that will never come for a walk-in.
      await applyInventoryDelta(tx, lineItems, -1);
      await applyLoyaltyDelta(tx, customer?.id, loyaltyPointsEarned, 1);
      // A cash walk-in goes into the open till (no-op if no drawer is open).
      if (input.paymentMethod === 'CASH') {
        await recordCashMovement(tx, {
          restaurantId,
          type: 'SALE',
          amountCents: pricing.totalCents,
          createdById: userId,
          orderId: created.id,
          reason: `Order #${created.orderNumber}`,
        });
      }

      return created;
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'order.walk_in_created',
      entityType: 'Order',
      entityId: order.id,
      metadata: {
        orderNumber: order.orderNumber,
        paymentMethod: input.paymentMethod,
        totalCents: pricing.totalCents,
      },
    });

    this.logger.log(
      `Walk-in order ${order.orderNumber} created for ${restaurant.slug} (${input.paymentMethod})`,
    );

    // A deferred card order isn't real until the tap lands -- markOrderPaid fires the
    // "NEW ORDER" alert then, so firing it here would send the kitchen an unpaid ticket.
    if (!deferPayment) {
      // Same notification an online order gets the instant Stripe confirms the
      // charge -- the money already moved, so this order is exactly as "real".
      void this.notifications.onOrderStatus(order, restaurant, 'PENDING').catch((err) => {
        this.logger.error(`Notification failed for walk-in order ${order.id}: ${(err as Error).message}`);
      });
    }

    return order;
  }

  /**
   * Settle a pay-at-desk dine-in order at the counter -- staff collected cash or ran a
   * card terminal, so the bill is now paid. Unlike a Stripe order there's no webhook to
   * flip the payment; this is that flip. Inventory already left at creation (the kitchen
   * cooked it) and the "NEW ORDER" alert already fired, so this does NOT touch stock or
   * re-notify the kitchen -- it only marks the money in and credits loyalty, which was
   * deliberately held back until the bill was actually settled.
   *
   * `method` records how it was collected (cash vs terminal). `amountCents` lets the
   * counter take a PARTIAL payment -- some cash now, the rest later -- leaving the order
   * PARTIALLY_PAID until the running balance reaches the total. Omit it to settle the
   * whole remaining balance in one go. Loyalty is credited (once) only when the bill is
   * fully covered. Idempotent: settling an already-paid order is a no-op.
   */
  async settleAtDesk(
    restaurantId: string,
    orderId: string,
    opts: { userId: string; method?: 'CASH' | 'CARD_TERMINAL'; amountCents?: number },
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: { payment: true, customer: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (!order.payAtDesk) {
      throw new BadRequestException('This order was not placed to pay at the desk');
    }
    if (!order.payment || order.payment.status === 'PAID') {
      // Already settled -- return the current order rather than double-crediting loyalty.
      return this.findById(restaurantId, orderId);
    }

    const total = order.payment.amountCents;
    const alreadyPaid = order.payment.amountPaidCents;
    const remaining = Math.max(0, total - alreadyPaid);
    // Default to clearing the whole remaining balance; a smaller amount is a part payment.
    // Never take more than what's owed (overpayment belongs in a tip, not a bill).
    const collect = Math.min(remaining, Math.max(1, Math.round(opts.amountCents ?? remaining)));
    const newPaid = alreadyPaid + collect;
    const fullyPaid = newPaid >= total;

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { orderId },
        data: {
          amountPaidCents: newPaid,
          status: fullyPaid ? 'PAID' : 'PARTIALLY_PAID',
          ...(fullyPaid ? { paidAt: new Date() } : {}),
          ...(opts.method ? { method: opts.method } : {}),
        },
      });
      // Loyalty is held back until the bill is ACTUALLY settled in full, so a table that
      // pays half and walks never banks points on the unpaid half.
      if (fullyPaid) {
        await applyLoyaltyDelta(tx, order.customerId, order.loyaltyPointsEarned, 1);
      }
      // Cash goes into the open till as it's collected (no-op if no drawer is open) --
      // the amount actually handed over, not the whole bill.
      if (opts.method === 'CASH') {
        await recordCashMovement(tx, {
          restaurantId,
          type: 'SALE',
          amountCents: collect,
          createdById: opts.userId,
          orderId,
          reason: `Order #${order.orderNumber}${fullyPaid ? '' : ' (part payment)'}`,
        });
      }
      await tx.orderEvent.create({
        data: {
          orderId,
          status: order.status,
          source: 'restaurant',
          note: fullyPaid
            ? `Settled at desk (${opts.method === 'CASH' ? 'cash' : 'card terminal'})`
            : `Part payment ${(collect / 100).toFixed(2)} ${order.currency} (${opts.method === 'CASH' ? 'cash' : 'card terminal'}) — ${((total - newPaid) / 100).toFixed(2)} remaining`,
        },
      });
    });

    await this.audit.log({
      restaurantId,
      userId: opts.userId,
      action: fullyPaid ? 'order.settled_at_desk' : 'order.part_payment',
      entityType: 'Order',
      entityId: orderId,
      metadata: { orderNumber: order.orderNumber, collectedCents: collect, paidCents: newPaid, totalCents: total },
    });

    this.logger.log(
      `Order ${order.orderNumber} ${fullyPaid ? 'settled' : 'part-paid'} at desk (${collect}/${total} ${order.currency})`,
    );
    return this.findById(restaurantId, orderId);
  }

  /**
   * The open order for a given table, if there is one still running. Used to answer
   * "this table already has a tab — add to it" rather than opening a second ticket.
   * An order counts as an open tab while it's a dine-in order that hasn't been paid,
   * completed or cancelled. Returns null when the table is clear.
   */
  async findOpenTabForTable(restaurantId: string, tableNumber: string) {
    const order = await this.prisma.order.findFirst({
      where: {
        restaurantId,
        tableNumber,
        fulfillment: 'DINE_IN',
        status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'] },
        // Only a still-open bill. A tab that's been settled online or at the desk is
        // closed — the next round is a fresh ticket.
        payment: { status: { notIn: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
      },
      orderBy: { createdAt: 'desc' },
      include: this.orderInclude(),
    });
    return order;
  }

  /**
   * Add another round to an open table tab — the customer re-scanned and wants more,
   * or staff are adding an item someone asked for at the table. The items append to the
   * SAME order so the table gets one bill, and the whole order is re-priced (subtotal,
   * tax, total, loyalty) from the full item set so tax stays exact on the new subtotal.
   *
   * Only ever touches an unpaid, open dine-in order. A tab that's already been paid is
   * closed — you can't silently grow a bill the customer already settled; that would be
   * a second charge they never agreed to. The new items' stock leaves now (the kitchen
   * cooks them immediately), matching how the original items were handled.
   */
  async addTabItems(
    restaurantId: string,
    orderId: string,
    input: Pick<CreateOrderInput, 'items'>,
    opts: { source: 'customer' | 'restaurant'; userId?: string },
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: { items: { include: { modifiers: true } }, payment: true, restaurant: true },
    });
    if (!order) throw new NotFoundException('Order not found');
    if (order.fulfillment !== 'DINE_IN') {
      throw new BadRequestException('Only dine-in table orders can run a tab');
    }
    if (!['PENDING', 'ACCEPTED', 'PREPARING', 'READY'].includes(order.status)) {
      throw new BadRequestException('This order is closed — start a new one');
    }
    if (order.payment && ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.payment.status)) {
      throw new BadRequestException(
        'This bill is already paid. Place a new order for anything else.',
      );
    }

    const restaurant = order.restaurant;
    const newItems = await this.resolveLineItems(restaurantId, input);

    // Re-price the WHOLE tab from every item (the ones already on it + the new round),
    // so tax is computed on the real running subtotal, not added piecemeal. Fees, tip
    // and any discount stay exactly as they were frozen on the original ticket.
    const existingPriced: PricedLineItem[] = order.items.map((it) => ({
      productId: it.productId ?? '',
      name: it.name,
      unitPriceCents: it.unitPriceCents,
      quantity: it.quantity,
      modifiers: it.modifiers.map((m) => ({
        modifierId: m.modifierId ?? '',
        name: m.name,
        priceCents: m.priceCents,
        quantity: m.quantity,
      })),
    }));

    const pricing = priceOrder({
      items: [...existingPriced, ...newItems],
      taxRateBps: restaurant.taxRateBps,
      taxComponents: (restaurant.taxComponents as TaxComponent[] | null) ?? undefined,
      taxDeliveryFee: restaurant.taxDeliveryFee,
      fulfillment: 'DINE_IN',
      serviceFeeCents: order.serviceFeeCents,
      // Recompute the service charge from the restaurant's current setting so a PERCENT
      // charge grows with the bigger tab (a flat one stays put).
      serviceChargeType: restaurant.serviceChargeType,
      serviceChargeCents: restaurant.serviceChargeCents,
      serviceChargeBps: restaurant.serviceChargeBps,
      tipCents: order.tipCents,
      discountCents: order.discountCents,
    });

    // A new round must be consciously picked up by the kitchen, not silently folded into
    // whatever the ticket was doing. Send it back to the NEW column (PENDING) so the
    // kitchen ACCEPTS the addition, exactly like a fresh order — the card still carries
    // the same order number and its already-served items, so it reads as an extension of
    // the same tab, not a second ticket. (An order still sitting in NEW stays there.)
    const reopenedStatus: OrderStatus | undefined = order.status === 'PENDING' ? undefined : 'PENDING';

    const loyaltyPointsEarned =
      restaurant.loyaltyEnabled && this.loyaltyAllowedByPlan(restaurant)
        ? pointsForSubtotal(pricing.subtotalCents, restaurant.loyaltyPointsPerDollar)
        : order.loyaltyPointsEarned;

    const updated = await this.prisma.$transaction(async (tx) => {
      // Append the new items as their own OrderItem rows (existing rows are untouched,
      // so the ticket reads as rounds in the order they were sent to the kitchen).
      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotalCents: pricing.subtotalCents,
          taxCents: pricing.taxCents,
          taxLines: pricing.taxLines as unknown as Prisma.InputJsonValue,
          totalCents: pricing.totalCents,
          serviceChargeCents: pricing.serviceChargeCents,
          loyaltyPointsEarned,
          ...(reopenedStatus ? { status: reopenedStatus } : {}),
          items: {
            create: newItems.map((item) => {
              const modifiersCents = item.modifiers.reduce((s, m) => s + m.priceCents, 0);
              return {
                name: item.name,
                quantity: item.quantity,
                unitPriceCents: item.unitPriceCents,
                totalCents: (item.unitPriceCents + modifiersCents) * item.quantity,
                notes: item.notes,
                productId: item.productId,
                modifiers: {
                  create: item.modifiers.map((m) => ({
                    name: m.name,
                    priceCents: m.priceCents,
                    quantity: m.quantity,
                    modifierId: m.modifierId,
                  })),
                },
              };
            }),
          },
          events: {
            create: {
              status: reopenedStatus ?? order.status,
              source: opts.source,
              note:
                `Added to tab: ${newItems.map((i) => `${i.quantity}× ${i.name}`).join(', ')}` +
                (reopenedStatus ? ' — new round sent to the kitchen' : ''),
            },
          },
        },
      });

      // The unpaid Payment tracks the running total so a later settle-at-desk collects
      // the whole tab, not just the first round.
      await tx.payment.update({
        where: { orderId },
        data: { amountCents: pricing.totalCents },
      });

      // The new round is going to the kitchen now, so its stock leaves now — same as
      // the original items on a pay-at-desk order.
      await applyInventoryDelta(tx, newItems, -1);
    });

    void updated;

    await this.audit.log({
      restaurantId,
      userId: opts.userId,
      action: 'order.tab_items_added',
      entityType: 'Order',
      entityId: orderId,
      metadata: {
        orderNumber: order.orderNumber,
        addedItems: newItems.map((i) => `${i.quantity}× ${i.name}`),
        newTotalCents: pricing.totalCents,
      },
    });

    this.logger.log(
      `Added ${newItems.length} item(s) to tab ${order.orderNumber} (new total ${pricing.totalCents} ${order.currency})`,
    );

    // No push notification here on purpose: onOrderStatus is a status-CHANGE notifier
    // and would text the customer a second "order placed". The kitchen board polls
    // listActive and re-renders the updated ticket within its refresh interval, and the
    // event log above records exactly what was added — that's the right signal for
    // "more food for a table already cooking", without a misleading duplicate message.
    return this.findById(restaurantId, orderId);
  }

  /**
   * Turn cart references into priced line items, reading every price from the DB.
   *
   * Also enforces the modifier group rules the menu declares: a required "Size"
   * group must have a selection, a SINGLE group can't take two, a MULTIPLE group
   * can't exceed maxSelections, and every chosen modifier must actually belong to
   * the product being ordered (otherwise you could attach a $0 modifier from a
   * cheaper item, or one from another restaurant entirely).
   */
  private async resolveLineItems(
    restaurantId: string,
    input: Pick<CreateOrderInput, 'items'>,
  ): Promise<Array<PricedLineItem & { notes?: string }>> {
    const productIds = [...new Set(input.items.map((i) => i.productId))];

    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, restaurantId, isAvailable: true },
      include: {
        modifierGroups: { include: { modifiers: true } },
      },
    });

    const byId = new Map(products.map((p) => [p.id, p]));

    const missing = productIds.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'ItemsUnavailable',
        message: 'Some items in your cart are no longer available',
        unavailableProductIds: missing,
      });
    }

    return input.items.map((cartItem) => {
      const product = byId.get(cartItem.productId)!;

      // Index this product's own modifiers. A modifier id not in here is either
      // from a different product or a different tenant — either way, rejected.
      const validModifiers = new Map(
        product.modifierGroups.flatMap((g) =>
          g.modifiers.map((m) => [m.id, { modifier: m, group: g }] as const),
        ),
      );

      const selected = cartItem.modifierIds.map((id) => {
        const found = validModifiers.get(id);
        if (!found) {
          throw new BadRequestException(
            `Option is not valid for "${product.name}" — please rebuild this item`,
          );
        }
        if (!found.modifier.isAvailable) {
          throw new BadRequestException(
            `"${found.modifier.name}" is sold out`,
          );
        }
        return found;
      });

      for (const group of product.modifierGroups) {
        const count = selected.filter((s) => s.group.id === group.id).length;

        if (group.required && count < Math.max(1, group.minSelections)) {
          throw new BadRequestException(`Please choose a ${group.name} for "${product.name}"`);
        }
        if (count < group.minSelections) {
          throw new BadRequestException(
            `"${product.name}" needs at least ${group.minSelections} from ${group.name}`,
          );
        }
        if (count > group.maxSelections) {
          throw new BadRequestException(
            `"${product.name}" allows at most ${group.maxSelections} from ${group.name}`,
          );
        }
        if (group.selectionType === 'SINGLE' && count > 1) {
          throw new BadRequestException(`Only one ${group.name} may be chosen for "${product.name}"`);
        }
      }

      return {
        productId: product.id,
        name: product.name,
        unitPriceCents: product.priceCents, // from the DB, never from the client
        quantity: cartItem.quantity,
        notes: cartItem.notes,
        modifiers: selected.map(({ modifier }) => ({
          modifierId: modifier.id,
          name: modifier.name,
          priceCents: modifier.priceCents, // likewise
          quantity: 1,
        })),
      };
    });
  }

  private assertFulfillmentAllowed(
    restaurant: {
      pickupEnabled: boolean;
      deliveryEnabled: boolean;
      dineInEnabled: boolean;
      planTier?: PlanTier | null;
    },
    input: Pick<CreateOrderInput, 'fulfillment'>,
  ): void {
    const enabled: Record<string, boolean> = {
      PICKUP: restaurant.pickupEnabled,
      DELIVERY: restaurant.deliveryEnabled,
      DINE_IN: restaurant.dineInEnabled,
    };
    // The plan is the source of truth: courier delivery requires a plan that
    // includes it, even if the old flag is still on. (planTier is absent only in the
    // pre-migration fallback, where we fail open.) Pickup and dine-in are on every
    // plan, so only delivery is plan-gated here.
    if (
      input.fulfillment === 'DELIVERY' &&
      restaurant.planTier &&
      !planAllows(restaurant.planTier, 'DELIVERY')
    ) {
      throw new BadRequestException('delivery is not available at this restaurant');
    }
    if (!enabled[input.fulfillment]) {
      throw new BadRequestException(
        `${input.fulfillment.toLowerCase().replace('_', '-')} is not available at this restaurant`,
      );
    }
  }

  private resolveSchedule(
    restaurant: { scheduledOrdersEnabled: boolean; timezone: string; businessHours: unknown },
    input: CreateOrderInput,
  ): Date | null {
    if (!input.scheduledFor) return null;

    if (!restaurant.scheduledOrdersEnabled) {
      throw new BadRequestException('This restaurant does not accept scheduled orders');
    }

    const when = new Date(input.scheduledFor);
    const now = Date.now();

    // 15 minutes is the floor — anything sooner is effectively an ASAP order and
    // gives the kitchen no runway.
    if (when.getTime() < now + 15 * 60_000) {
      throw new BadRequestException('Scheduled orders must be at least 15 minutes out');
    }
    if (when.getTime() > now + 14 * 24 * 60 * 60_000) {
      throw new BadRequestException('Orders cannot be scheduled more than 14 days ahead');
    }

    const hours = restaurant.businessHours as BusinessHours;
    if (!isOpenAt(hours, restaurant.timezone, when)) {
      throw new BadRequestException('The restaurant is closed at that time');
    }

    return when;
  }

  /**
   * Per-restaurant sequential order number, reset daily: "0311-014" is the 14th
   * order on March 11. Kitchen staff read these aloud; a cuid would be unusable.
   *
   * Uniqueness is enforced by the @@unique([restaurantId, orderNumber]) index —
   * if two orders race to the same number, the second insert fails and the retry
   * picks up the next one.
   */
  private async nextOrderNumber(restaurantId: string): Promise<string> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayCount = await this.prisma.order.count({
      where: { restaurantId, createdAt: { gte: startOfDay } },
    });

    const now = new Date();
    const prefix = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    return `${prefix}-${String(todayCount + 1).padStart(3, '0')}`;
  }

  private async upsertCustomer(
    restaurantId: string,
    customer: { name: string; phone: string; email: string },
    clerkUserId?: string,
  ) {
    // Phone is the identity key within a tenant: the same number ordering again
    // rolls up to one customer record, which is what the CRM page depends on.
    //
    // `clerkUserId` is only ever SET, never cleared. A signed-in customer who later
    // checks out as a guest (different browser, forgot to log in) must not have
    // their account detached from their own history — so the update only writes it
    // when we have one.
    return this.prisma.customer.upsert({
      where: { restaurantId_phone: { restaurantId, phone: customer.phone } },
      create: {
        restaurantId,
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        clerkUserId,
      },
      update: {
        name: customer.name,
        // Only ever SET, never cleared -- a walk-in re-order where staff didn't
        // retype the email must not blank out an address already on file from
        // an earlier order (online or a previous walk-in that did have one).
        ...(customer.email ? { email: customer.email } : {}),
        ...(clerkUserId ? { clerkUserId } : {}),
      },
    });
  }

  // --- Reads ----------------------------------------------------------------

  async list(restaurantId: string, opts: ListOrdersOptions = {}) {
    const limit = Math.min(opts.limit ?? 50, 100);

    const where: Prisma.OrderWhereInput = {
      restaurantId,
      ...(opts.status?.length ? { status: { in: opts.status } } : {}),
      ...(opts.paidOnly
        ? { OR: [{ payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } }, { payAtDesk: true }] }
        : {}),
      ...(opts.from || opts.to
        ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
        : {}),
    };

    const orders = await this.prisma.order.findMany({
      where,
      include: this.orderInclude(),
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    });

    const hasMore = orders.length > limit;
    return {
      orders: hasMore ? orders.slice(0, limit) : orders,
      nextCursor: hasMore ? orders[limit - 1].id : null,
    };
  }

  /** The kitchen board: everything still in flight, oldest first. */
  async listActive(restaurantId: string) {
    return this.prisma.order.findMany({
      where: {
        restaurantId,
        status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY', 'DRIVER_ASSIGNED', 'OUT_FOR_DELIVERY'] },
        // Paid orders, plus pay-at-desk tables that are cooking now and will settle at
        // the counter — the kitchen must see those even though the money hasn't landed.
        OR: [{ payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } }, { payAtDesk: true }],
      },
      include: this.orderInclude(),
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Open orders still waiting to be paid — what the staff payment app lists so a
   * member can pick one and take the card in person. Pay-at-desk tables and any other
   * unpaid-but-live order (a walk-in staff want to charge by card) both qualify.
   */
  async listAwaitingPayment(restaurantId: string) {
    return this.prisma.order.findMany({
      where: {
        restaurantId,
        status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'] },
        payment: { status: 'PENDING' },
      },
      include: this.orderInclude(),
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(restaurantId: string, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, restaurantId },
      include: { ...this.orderInclude(), events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * Public tracking lookup. Keyed by the unguessable trackingToken, NOT the
   * order id — so the URL we text a customer can't be walked to read someone
   * else's order. Returns a trimmed projection: no internal ids, no Uber fee.
   */
  /**
   * The public "now serving" board -- a TV by the counter or a link a table
   * QR points at, so a pickup/dine-in customer can watch their own order
   * without asking staff. Identified by the last 3 digits of the order
   * number (the same number texted to them at every step) plus a FIRST name
   * (truncated here, not trusted to the client) -- no phone, no item
   * contents; a full name plus a live pickup code is more than a stranger's
   * screen needs. Delivery orders never appear here -- nobody standing in
   * the restaurant is waiting on one.
   */
  async listStatusBoard(restaurantId: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        restaurantId,
        fulfillment: { in: ['PICKUP', 'DINE_IN'] },
        status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY'] },
        payment: { status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } },
      },
      select: {
        orderNumber: true,
        status: true,
        fulfillment: true,
        tableNumber: true,
        createdAt: true,
        acceptedAt: true,
        estimatedReadyAt: true,
        customerName: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    return orders.map((o) => ({
      // The order number's own last 3 digits, not a separate random code -- the
      // same number is on every text this customer already got (placed,
      // confirmed, ready), so there's nothing new for them to go looking for.
      shortId: o.orderNumber.slice(-3),
      status: o.status,
      fulfillment: o.fulfillment,
      tableNumber: o.tableNumber,
      createdAt: o.createdAt,
      acceptedAt: o.acceptedAt,
      estimatedReadyAt: o.estimatedReadyAt,
      customerFirstName: o.customerName?.trim().split(/\s+/)[0] || null,
    }));
  }

  async findByTrackingToken(token: string) {
    const order = await this.prisma.order.findUnique({
      where: { trackingToken: token },
      include: {
        items: { include: { modifiers: true } },
        payment: { select: { status: true } },
        delivery: {
          select: {
            id: true,
            status: true,
            trackingUrl: true,
            courierName: true,
            courierVehicle: true,
            // The courier's live position. This is what puts a moving driver on
            // the customer's map. Deliberately NOT their phone number — we give
            // the customer a map, not a stranger's mobile.
            courierLatitude: true,
            courierLongitude: true,
            dropoffEta: true,
            pickedUpAt: true,
            deliveredAt: true,
            // The route so far, so the map draws a line rather than a jumping pin.
            pings: {
              orderBy: { createdAt: 'asc' },
              select: { latitude: true, longitude: true },
              take: 200,
            },
          },
        },
        restaurant: {
          select: {
            name: true,
            slug: true,
            phone: true,
            logoUrl: true,
            brandPrimaryColor: true,
            street: true,
            city: true,
            state: true,
            // The map needs to plot where the food is coming FROM.
            latitude: true,
            longitude: true,
            prepTimeMinutes: true,
          },
        },
        events: {
          select: { status: true, createdAt: true, note: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!order) throw new NotFoundException('Order not found');
    return order;
  }

  /**
   * A customer finding their own order again, with no account and no link.
   *
   * They closed the tab, or lost the text, and now want to know where their food
   * is. Verified by (order number + phone), because an order number alone is
   * sequential and guessable — 0712-014 tells you 0712-013 exists — and a lookup
   * on that alone would be a way to read strangers' orders and their addresses.
   *
   * On success we return the same payload as the tracking page. The 404 is
   * deliberately identical for "no such order" and "wrong phone number": telling
   * an attacker which of the two they got wrong is telling them half the answer.
   */
  async lookupForCustomer(restaurantId: string, orderNumber: string, phone: string) {
    const normalizedPhone = phone.replace(/\D/g, '');

    const order = await this.prisma.order.findFirst({
      where: {
        restaurantId,
        orderNumber: orderNumber.trim().toUpperCase(),
      },
      select: { trackingToken: true, customerPhone: true },
    });

    // Compare on digits only — the customer typed "(415) 555-0188" and we stored
    // "+14155550188". Requiring an exact string match here would fail almost every
    // real lookup, and they'd call the restaurant instead.
    const storedDigits = order?.customerPhone.replace(/\D/g, '') ?? '';
    const matches =
      Boolean(order) &&
      storedDigits.length > 0 &&
      (storedDigits.endsWith(normalizedPhone) || normalizedPhone.endsWith(storedDigits));

    if (!order || !matches) {
      this.logger.warn(`Failed order lookup for ${orderNumber} at restaurant ${restaurantId}`);
      throw new NotFoundException(
        "We couldn't find that order. Check the order number and the phone number you used.",
      );
    }

    return this.findByTrackingToken(order.trackingToken);
  }

  // --- State machine --------------------------------------------------------

  /**
   * The only way an order's status ever changes. Every caller — dashboard,
   * Stripe webhook, Uber webhook — funnels through here, so the legal-transition
   * table in @dinedirect/shared is genuinely the single source of truth, and every
   * change lands in OrderEvent for the customer's timeline.
   */
  async transition(
    restaurantId: string,
    orderId: string,
    to: OrderStatus,
    opts: { userId?: string; source?: string; note?: string; skipNotification?: boolean } = {},
  ) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, restaurantId },
      include: {
        payment: true,
        restaurant: true,
        items: { select: { productId: true, quantity: true } },
      },
    });
    if (!order) throw new NotFoundException('Order not found');

    if (order.status === to) return order; // idempotent: webhooks retry

    if (!canTransition(order.status, to)) {
      throw new ConflictException({
        statusCode: 409,
        error: 'IllegalTransition',
        message: `An order that is ${order.status} cannot become ${to}`,
        from: order.status,
        to,
      });
    }

    // Never let a kitchen start work on an unpaid order -- EXCEPT a pay-at-desk table,
    // which is unpaid on purpose (cook now, settle at the counter later). Its stock
    // already left and the kitchen was alerted at creation, so accepting it is exactly
    // what's meant to happen; the bill is collected via settleAtDesk when the table pays.
    if (to === 'ACCEPTED' && order.payment?.status !== 'PAID' && !order.payAtDesk) {
      throw new ConflictException('Cannot accept an order that has not been paid');
    }

    // Don't let an order close while the bill is still unpaid -- completing/"picking up"
    // is the last step, and doing it on an unpaid tab loses the money. The front desk
    // settles it first (Take payment, on the Orders tab); only then can it be closed. A
    // PARTIALLY_PAID tab is still owed money, so it's blocked too.
    if (to === 'COMPLETED' && (order.payment?.status === 'PENDING' || order.payment?.status === 'PARTIALLY_PAID')) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Unpaid',
        message: 'Take payment on the Orders tab before closing this order',
      });
    }

    const now = new Date();
    const timestamps: Partial<Record<OrderStatus, Prisma.OrderUpdateInput>> = {
      // Scaled by how many items are actually in the order -- a 1-item pickup
      // and a 12-item catering order were getting the same flat estimate.
      // Kitchen staff can move it from the Kitchen board once they know better.
      ACCEPTED: {
        acceptedAt: now,
        estimatedReadyAt: new Date(
          now.getTime() +
            this.estimateReadyMinutes(order.items, order.restaurant.prepTimeMinutes) * 60_000,
        ),
      },
      READY: { readyAt: now },
      COMPLETED: { completedAt: now },
      DELIVERED: { completedAt: now },
      CANCELLED: { cancelledAt: now, cancelReason: opts.note },
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.update({
        where: { id: orderId },
        data: {
          status: to,
          ...(timestamps[to] ?? {}),
          events: {
            create: { status: to, source: opts.source ?? 'restaurant', note: opts.note },
          },
        },
        include: this.orderInclude(),
      });

      // Mark the current round done. Every item still un-prepared is what the kitchen
      // just finished; stamping preparedAt now means a later round added to this tab
      // (which arrives un-prepared) shows on the board as the only thing left to cook.
      if (to === 'READY') {
        await tx.orderItem.updateMany({
          where: { orderId, preparedAt: null },
          data: { preparedAt: now },
        });
      }

      // Roll up customer lifetime value exactly once, when the order lands.
      if (to === 'COMPLETED' || to === 'DELIVERED') {
        if (result.customerId) {
          await tx.customer.update({
            where: { id: result.customerId },
            data: {
              totalOrders: { increment: 1 },
              totalSpentCents: { increment: result.totalCents },
              lastOrderAt: now,
            },
          });
        }
      }

      // Stock and loyalty points only ever left the shelf/were credited once
      // this order was PAID -- cancelling an order that never got that far
      // never touched either, so there is nothing here to give back.
      if (to === 'CANCELLED' && order.payment?.status === 'PAID') {
        await applyInventoryDelta(tx, order.items, 1);
        await applyLoyaltyDelta(tx, order.customerId, order.loyaltyPointsEarned, -1);
      }

      return result;
    });

    await this.audit.log({
      restaurantId,
      userId: opts.userId,
      action: `order.${to.toLowerCase()}`,
      entityType: 'Order',
      entityId: orderId,
      metadata: { from: order.status, to, orderNumber: order.orderNumber },
    });

    if (!opts.skipNotification) {
      // Fire-and-forget: a Twilio outage must not roll back the kitchen's state.
      // The engine fans this out to BOTH the customer and the restaurant.
      void this.notifications.onOrderStatus(updated, order.restaurant, to).catch((err) => {
        this.logger.error(`Notification failed for order ${orderId}: ${err.message}`);
      });
    }

    return updated;
  }

  async cancel(restaurantId: string, orderId: string, reason: string, userId?: string) {
    return this.transition(restaurantId, orderId, 'CANCELLED', {
      userId,
      source: 'restaurant',
      note: reason,
    });
  }

  /**
   * The default countdown target: the restaurant's usual prep time, plus a
   * couple of minutes per item beyond the first. Not exact -- it can't be,
   * every kitchen and every dish is different -- which is exactly why
   * `setEstimatedReadyMinutes` below lets staff override it in one tap
   * rather than the board showing a number nobody trusts.
   */
  private estimateReadyMinutes(items: Array<{ quantity: number }>, basePrepMinutes: number): number {
    const itemCount = items.reduce((sum, i) => sum + i.quantity, 0);
    const extraMinutes = Math.max(0, itemCount - 1) * 2;
    return basePrepMinutes + extraMinutes;
  }

  /**
   * Kitchen staff overriding the countdown shown on the public status board --
   * "actually, 25 minutes" when the default guessed wrong, or the fryer's down
   * and everything's running late. Only meaningful while the kitchen is still
   * working the order; a READY/COMPLETED/CANCELLED order has nothing left to
   * count down to.
   */
  async setEstimatedReadyMinutes(
    restaurantId: string,
    orderId: string,
    minutesFromNow: number,
    userId?: string,
  ) {
    if (!Number.isFinite(minutesFromNow) || minutesFromNow < 0 || minutesFromNow > 180) {
      throw new BadRequestException('Minutes must be between 0 and 180');
    }

    const order = await this.prisma.order.findFirst({ where: { id: orderId, restaurantId } });
    if (!order) throw new NotFoundException('Order not found');

    if (!['ACCEPTED', 'PREPARING'].includes(order.status)) {
      throw new ConflictException(
        `Cannot set an ETA on an order that is ${order.status.toLowerCase()}`,
      );
    }

    const estimatedReadyAt = new Date(Date.now() + minutesFromNow * 60_000);

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: { estimatedReadyAt },
      include: this.orderInclude(),
    });

    await this.audit.log({
      restaurantId,
      userId,
      action: 'order.eta_changed',
      entityType: 'Order',
      entityId: orderId,
      metadata: { minutesFromNow, orderNumber: order.orderNumber },
    });

    return updated;
  }

  private orderInclude() {
    return {
      items: { include: { modifiers: true } },
      payment: true,
      delivery: true,
      customer: { select: { id: true, name: true, phone: true, totalOrders: true } },
    } satisfies Prisma.OrderInclude;
  }
}
