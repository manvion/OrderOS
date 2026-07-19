import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { updateReservationStatusSchema } from '@dinedirect/shared';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { CurrentUser, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ReservationsService } from './reservations.service';

/** Staff-only reservations management: the booking list and its lifecycle. */
@ApiTags('reservations')
@Controller('reservations')
@UseGuards(ClerkAuthGuard)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  @Roles('STAFF')
  list(@TenantId() restaurantId: string) {
    return this.reservations.listReservations(restaurantId);
  }

  @Patch(':id/status')
  @Roles('STAFF')
  updateStatus(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateReservationStatusSchema))
    body: z.infer<typeof updateReservationStatusSchema>,
  ) {
    return this.reservations.updateStatus(restaurantId, id, body.status, user.id);
  }
}
