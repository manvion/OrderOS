import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createReservationSchema, type CreateReservationInput } from '@dinedirect/shared';
import { Public, TenantId } from '../../common/auth/decorators';
import { PublicTenantGuard } from '../../common/auth/public-tenant.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { ReservationsService } from './reservations.service';

/**
 * The customer-facing reservations surface. Tenant resolved from the subdomain by
 * PublicTenantGuard, same as the rest of the storefront.
 */
@ApiTags('storefront')
@Controller('storefront/reservations')
@Public()
@UseGuards(PublicTenantGuard)
export class ReservationsPublicController {
  constructor(private readonly reservations: ReservationsService) {}

  /** Are reservations on, and the limits the booking form needs. */
  @Get()
  settings(@TenantId() restaurantId: string) {
    return this.reservations.settings(restaurantId);
  }

  /** Bookable slots for a given YYYY-MM-DD (in the restaurant's timezone). */
  @Get('availability')
  availability(@TenantId() restaurantId: string, @Query('date') date: string) {
    return this.reservations.availability(restaurantId, date ?? '');
  }

  /** Book a table. Auto-confirms when the slot is still open. */
  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  book(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(createReservationSchema)) body: CreateReservationInput,
  ) {
    return this.reservations.book(restaurantId, body);
  }
}
