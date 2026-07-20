import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { CurrentUser, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CashService } from './cash.service';

const openSchema = z.object({ openingFloatCents: z.number().int().min(0).max(10_000_00) });
const movementSchema = z.object({
  type: z.enum(['PAY_IN', 'PAY_OUT']),
  amountCents: z.number().int().min(1).max(10_000_00),
  reason: z.string().max(200).optional(),
});
const closeSchema = z.object({ countedCashCents: z.number().int().min(0).max(1_000_000_00) });

/** Staff-only cash-drawer management: open a till, record cash in/out, close with a count. */
@ApiTags('cash')
@Controller('cash')
@UseGuards(ClerkAuthGuard)
export class CashController {
  constructor(private readonly cash: CashService) {}

  /** The drawer open right now (with its movements + running totals), or null. */
  @Get('current')
  @Roles('STAFF')
  current(@TenantId() restaurantId: string) {
    return this.cash.current(restaurantId);
  }

  /** Recent closed shifts — the Z-report history. */
  @Get('history')
  @Roles('STAFF')
  history(@TenantId() restaurantId: string, @Query('limit') limit?: string) {
    return this.cash.history(restaurantId, limit ? Number(limit) : undefined);
  }

  @Post('open')
  @Roles('STAFF')
  open(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(openSchema)) body: z.infer<typeof openSchema>,
  ) {
    return this.cash.open(restaurantId, user.id, body.openingFloatCents);
  }

  @Post('movement')
  @Roles('STAFF')
  movement(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(movementSchema)) body: z.infer<typeof movementSchema>,
  ) {
    return this.cash.addMovement(restaurantId, user.id, body);
  }

  @Post('close')
  @Roles('STAFF')
  close(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(closeSchema)) body: z.infer<typeof closeSchema>,
  ) {
    return this.cash.close(restaurantId, user.id, body.countedCashCents);
  }
}
