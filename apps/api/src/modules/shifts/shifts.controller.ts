import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { shiftSchema, shiftUpdateSchema, type ShiftInput } from '@dinedirect/shared';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, CurrentUser, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ShiftsService } from './shifts.service';

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Invalid ${field}`);
  }
  return date;
}

@ApiTags('shifts')
@Controller('shifts')
@UseGuards(ClerkAuthGuard)
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  /** Staff always see only their own shifts; a manager can filter by anyone. */
  @Get()
  list(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.shifts.listShifts(restaurantId, user.role, user.id, {
      userId,
      from: parseDate(from, 'from'),
      to: parseDate(to, 'to'),
    });
  }

  @Post()
  @Roles('MANAGER')
  @Audit('shift.created', 'Shift')
  create(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(shiftSchema)) body: ShiftInput,
  ) {
    return this.shifts.createShift(restaurantId, body);
  }

  @Patch(':id')
  @Roles('MANAGER')
  @Audit('shift.updated', 'Shift')
  update(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(shiftUpdateSchema)) body: Partial<ShiftInput>,
  ) {
    return this.shifts.updateShift(restaurantId, id, body);
  }

  @Delete(':id')
  @Roles('MANAGER')
  @Audit('shift.deleted', 'Shift')
  async remove(@TenantId() restaurantId: string, @Param('id') id: string) {
    await this.shifts.deleteShift(restaurantId, id);
    return { success: true };
  }
}
