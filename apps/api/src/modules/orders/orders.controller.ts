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
import { Audit, CurrentUser, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { DeliveryService } from '../delivery/delivery.service';
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

const settleAtDeskSchema = z.object({
  /** How the counter collected. Defaults to card terminal if unspecified. */
  method: z.enum(['CASH', 'CARD_TERMINAL']).optional(),
});

const walkInItemSchema = z.object({
  productId: z.string().cuid(),
  quantity: z.number().int().min(1).max(99),
  notes: z.string().max(280).optional(),
  modifierIds: z.array(z.string().cuid()).max(50).default([]),
});

const walkInOrderSchema = z.object({
  items: z.array(walkInItemSchema).min(1).max(100),
  fulfillment: z.enum(['PICKUP', 'DINE_IN']),
  customerName: z.string().max(120).optional(),
  customerPhone: z.string().max(20).optional(),
  customerEmail: z.string().email().max(160).optional(),
  tableNumber: z.string().max(20).optional(),
  paymentMethod: z.enum(['CASH', 'CARD_TERMINAL']),
  notes: z.string().max(500).optional(),
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
  ) {}

  /** The kitchen board. Polled by the dashboard every few seconds. */
  @Get('active')
  listActive(@TenantId() restaurantId: string) {
    return this.orders.listActive(restaurantId);
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
    return this.orders.settleAtDesk(restaurantId, id, { userId: user.id, method: body.method });
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
