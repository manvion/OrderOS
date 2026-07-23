import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { OrderStatus } from '@prisma/client';
import { tabItemsSchema, type TabItemsInput } from '@dinedirect/shared';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, CurrentUser, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeliveryService } from '../delivery/delivery.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';
import { OrdersService } from './orders.service';

const transitionSchema = z.object({
  status: z.enum([
    'ACCEPTED',
    'PREPARING',
    'READY',
    'COMPLETED',
    'CANCELLED',
  ] as const satisfies readonly OrderStatus[]),
  note: z.string().max(500).optional(),
});

const cancelSchema = z.object({ reason: z.string().min(1).max(500) });

const etaSchema = z.object({ minutesFromNow: z.number().int().min(0).max(180) });

/** Correct the customer contact on an order — e.g. a mistyped delivery phone that a
 *  courier rejected. Phone and/or name; at least one must be present. */
const contactSchema = z
  .object({
    customerPhone: z.string().min(7).max(20).optional(),
    customerName: z.string().min(1).max(120).optional(),
  })
  .refine((b) => b.customerPhone !== undefined || b.customerName !== undefined, {
    message: 'Provide a phone number or a name to update',
  });

const settleAtDeskSchema = z.object({
  /** How the counter collected. Defaults to card terminal if unspecified. */
  method: z.enum(['CASH', 'CARD_TERMINAL']).optional(),
  /** A PARTIAL amount to collect now (cents). Omit to clear the whole remaining balance. */
  amountCents: z.number().int().min(1).max(1_000_000).optional(),
});

const walkInItemSchema = z.object({
  productId: z.string().cuid(),
  quantity: z.number().int().min(1).max(99),
  notes: z.string().max(280).optional(),
  modifierIds: z.array(z.string().cuid()).max(50).default([]),
});

const walkInAddressSchema = z.object({
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  state: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(60).optional(),
});

const walkInOrderSchema = z.object({
  items: z.array(walkInItemSchema).min(1).max(100),
  fulfillment: z.enum(['PICKUP', 'DINE_IN', 'DELIVERY']),
  customerName: z.string().max(120).optional(),
  customerPhone: z.string().max(20).optional(),
  customerEmail: z.string().email().max(160).optional(),
  tableNumber: z.string().max(20).optional(),
  // Required by the service when fulfillment is DELIVERY (a phone order to be delivered).
  deliveryAddress: walkInAddressSchema.optional(),
  paymentMethod: z.enum(['CASH', 'CARD_TERMINAL']),
  // Create the order UNPAID and leave it for the Terminal (Tap to Pay) to charge,
  // rather than trusting that money already changed hands. Pickup / dine-in only;
  // the service ignores it for a card that's already been collected elsewhere.
  deferPayment: z.boolean().optional(),
  notes: z.string().max(500).optional(),
});

/**
 * A counter phone order the customer pays online via a texted/emailed link, instead
 * of at the desk. Phone is required — it's the link's primary channel and the
 * customer key; email is optional (adds the email copy). Pickup / dine-in only for
 * now; delivery-by-link needs the address + courier path and is a separate step.
 */
const paymentLinkOrderSchema = z.object({
  items: z.array(walkInItemSchema).min(1).max(100),
  fulfillment: z.enum(['PICKUP', 'DINE_IN']),
  customerName: z.string().max(120).optional(),
  customerPhone: z.string().min(7).max(20),
  customerEmail: z.string().email().max(160).optional(),
  tableNumber: z.string().max(20).optional(),
});

/** Restaurant-facing order management. Customers use StorefrontController. */
@ApiTags('orders')
@Controller('orders')
@UseGuards(ClerkAuthGuard)
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
    // forwardRef: DeliveryModule imports OrdersModule (it drives the order state
    // machine from Uber webhooks) and we need to dispatch couriers from here.
    @Inject(forwardRef(() => DeliveryService))
    private readonly delivery: DeliveryService,
    // Mint + send a Stripe payment link for a counter phone order. One-way dep
    // (payments never imports orders), so no forwardRef needed.
    private readonly payments: PaymentsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The kitchen board. Polled by the dashboard every few seconds. */
  @Get('active')
  listActive(@TenantId() restaurantId: string) {
    return this.orders.listActive(restaurantId);
  }

  /** Unpaid open orders — the staff payment app lists these to take a card in person. */
  @Get('awaiting-payment')
  @Roles('STAFF')
  listAwaitingPayment(@TenantId() restaurantId: string) {
    return this.orders.listAwaitingPayment(restaurantId);
  }

  @Get()
  list(
    @TenantId() restaurantId: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orders.list(restaurantId, {
      status: status ? (status.split(',') as OrderStatus[]) : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      cursor,
      limit: limit ? Number(limit) : undefined,
      // The history view hides orders that were never paid for — they're
      // abandoned checkouts, not orders.
      paidOnly: true,
    });
  }

  @Get(':id')
  get(@TenantId() restaurantId: string, @Param('id') id: string) {
    return this.orders.findById(restaurantId, id);
  }

  /**
   * Move an order through the lifecycle.
   *
   * Marking a DELIVERY order READY also dispatches an Uber courier, in the same
   * request. Doing it here rather than making the dashboard fire a second call
   * means there's no window where the food is ready and nobody has been asked to
   * come get it.
   *
   * If Uber fails, the order still becomes READY — the kitchen's reality doesn't
   * depend on Uber's API being up. The failure is recorded on the Delivery row,
   * queued for retry, and returned to the dashboard as a warning so staff can
   * fall back to their own driver.
   */
  @Patch(':id/status')
  @Audit('order.status_changed', 'Order')
  async transition(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(transitionSchema)) body: { status: OrderStatus; note?: string },
  ) {
    const order = await this.orders.transition(restaurantId, id, body.status, {
      userId: user.id,
      source: 'restaurant',
      note: body.note,
    });

    if (body.status !== 'READY' || order.fulfillment !== 'DELIVERY') {
      return { order };
    }

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { uberDirectEnabled: true, selfDeliveryEnabled: true },
    });
    if (!restaurant) return { order };

    /**
     * Who carries this one?
     *
     * If the restaurant has BOTH an Uber account and their own driver, we must not
     * guess. The right answer genuinely depends on how far away the customer is and
     * whether their driver is on shift tonight — facts we don't have and the person
     * at the pass does. So we hand the decision back to them rather than silently
     * spending their money on a courier they didn't need.
     */
    if (restaurant.uberDirectEnabled && restaurant.selfDeliveryEnabled) {
      return { order, needsDeliveryChoice: true as const };
    }

    if (!restaurant.uberDirectEnabled) {
      // Self-delivery only (or no delivery integration at all). The order is READY;
      // their driver takes it from here.
      return { order };
    }

    try {
      const delivery = await this.delivery.createDelivery(restaurantId, id, user.id);
      return { order, delivery };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Courier dispatch failed for order ${order.orderNumber}: ${message}`);
      return {
        order,
        delivery: null,
        warning: `The order is marked ready, but we could not reach Uber: ${message}. We'll keep retrying — arrange your own driver if it's urgent.`,
      };
    }
  }

  /**
   * Kitchen staff overriding the countdown the public status board shows for
   * this order -- the default guessed wrong, or the kitchen's running behind.
   */
  @Patch(':id/eta')
  @Audit('order.eta_changed', 'Order')
  setEta(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(etaSchema)) body: { minutesFromNow: number },
  ) {
    return this.orders.setEstimatedReadyMinutes(restaurantId, id, body.minutesFromNow, user.id);
  }

  /**
   * Fix the customer's contact details on a live order — most often a delivery phone a
   * courier declined (e.g. a placeholder like 555-555-5555). Correcting it lets staff
   * re-dispatch without re-taking the whole order.
   */
  @Patch(':id/contact')
  @Roles('STAFF')
  @Audit('order.contact_updated', 'Order')
  updateContact(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(contactSchema)) body: z.infer<typeof contactSchema>,
  ) {
    return this.orders.updateContact(restaurantId, id, body);
  }

  @Post(':id/cancel')
  @Audit('order.cancelled', 'Order')
  async cancel(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(cancelSchema)) body: { reason: string },
  ) {
    const order = await this.orders.cancel(restaurantId, id, body.reason, user.id);

    /**
     * A courier already on the road has no idea the order was just cancelled — our
     * database changing does not tell Uber or DoorDash anything. Best-effort: a
     * courier that already has the food in hand may refuse to cancel, which is
     * exactly the case staff need to hear about (call the customer, intercept the
     * bag), not have silently swallowed. The order stays cancelled either way —
     * this never undoes it.
     */
    const delivery = await this.prisma.delivery.findFirst({ where: { orderId: id, restaurantId } });
    if (delivery && delivery.provider !== 'SELF' && !['CANCELLED', 'DELIVERED', 'FAILED'].includes(delivery.status)) {
      try {
        await this.delivery.cancelDelivery(restaurantId, id, user.id);
      } catch (err) {
        this.logger.warn(
          `Order ${order.orderNumber} was cancelled but its courier could not be: ${(err as Error).message}`,
        );
      }
    }

    return order;
  }

  /**
   * A walk-in or phone order, entered at the counter and paid in person --
   * cash or a card terminal, never Stripe. See OrdersService.createWalkIn.
   */
  @Post('walk-in')
  @Audit('order.walk_in_created', 'Order')
  walkIn(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(walkInOrderSchema)) body: z.infer<typeof walkInOrderSchema>,
  ) {
    return this.orders.createWalkIn(restaurantId, body, user.id);
  }

  /**
   * A counter phone order the customer pays by link. The order is created UNPAID —
   * exactly the storefront online path (orders.create + a Stripe checkout session) —
   * so it does NOT reach the kitchen or touch stock until the customer actually pays;
   * the Stripe webhook flips it and fires the usual "new order" alerts then. The link
   * is texted/emailed to the customer AND returned to the POS to show and read out.
   */
  @Post('payment-link')
  @Roles('STAFF')
  @Audit('order.payment_link_created', 'Order')
  async createPaymentLinkOrder(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(paymentLinkOrderSchema)) body: z.infer<typeof paymentLinkOrderSchema>,
  ) {
    const order = await this.orders.create(restaurantId, {
      items: body.items,
      fulfillment: body.fulfillment,
      customer: {
        name: body.customerName?.trim() || 'Customer',
        phone: body.customerPhone,
        email: body.customerEmail ?? '',
      },
      tipCents: 0,
      ...(body.tableNumber ? { tableNumber: body.tableNumber } : {}),
    });

    // Same unpaid-order → Stripe checkout pair the storefront uses. Throws a clean
    // BadRequest if the restaurant hasn't finished Stripe onboarding.
    const { checkoutUrl } = await this.payments.createCheckoutSession(order.id);

    // Send it both ways (best-effort); it's also returned for the POS to show/QR.
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (restaurant) {
      await this.notifications.sendPaymentLink(order, restaurant, checkoutUrl).catch(() => {
        // A failed text/email doesn't lose the order or the link — the POS still has it.
      });
    }

    return { orderId: order.id, orderNumber: order.orderNumber, checkoutUrl };
  }

  /**
   * Settle a pay-at-desk dine-in order — the customer is paying at the counter now.
   * Marks the unpaid order paid and credits loyalty; no Stripe involved.
   */
  @Post(':id/settle-at-desk')
  @Audit('order.settled_at_desk', 'Order')
  settleAtDesk(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(settleAtDeskSchema)) body: z.infer<typeof settleAtDeskSchema>,
  ) {
    return this.orders.settleAtDesk(restaurantId, id, {
      userId: user.id,
      method: body.method,
      amountCents: body.amountCents,
    });
  }

  /**
   * Text/email the customer a Stripe link to settle an EXISTING unpaid order — the
   * "pay by link" option when a pay-at-desk table would rather pay online than hand over
   * cash or a card. Reuses the same unpaid-order → checkout pair the storefront and the
   * new-order link flow use; the webhook flips it to paid (markOrderPaid, which knows a
   * pay-at-desk order is already cooking and won't re-alert the kitchen). The link is
   * also returned so the POS can show a QR to scan at the counter.
   */
  @Post(':id/payment-link')
  @Roles('STAFF')
  @Audit('order.payment_link_created', 'Order')
  async createOrderPaymentLink(@TenantId() restaurantId: string, @Param('id') id: string) {
    // findById scopes to this tenant and 404s otherwise — the authorization for :id.
    const order = await this.orders.findById(restaurantId, id);
    const { checkoutUrl } = await this.payments.createCheckoutSession(order.id);

    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (restaurant) {
      await this.notifications.sendPaymentLink(order, restaurant, checkoutUrl).catch(() => {
        // A failed text/email doesn't lose the link — the POS still shows it to scan.
      });
    }

    return { orderId: order.id, orderNumber: order.orderNumber, checkoutUrl };
  }

  /**
   * Staff adding a round to an open table tab — someone at the table asked for another
   * item. Appends to the same order so the table gets one bill.
   */
  @Post(':id/tab-items')
  @Audit('order.tab_items_added', 'Order')
  addTabItems(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(tabItemsSchema)) body: TabItemsInput,
  ) {
    return this.orders.addTabItems(restaurantId, id, body, { source: 'restaurant', userId: user.id });
  }
}
