import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { Public, TenantId } from '../../common/auth/decorators';
import { PublicTenantGuard } from '../../common/auth/public-tenant.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CateringService } from './catering.service';

const submitSchema = z.object({
  type: z.enum(['PACKAGE', 'CUSTOM']),
  packageId: z.string().cuid().optional(),
  customerName: z.string().min(1).max(120),
  customerEmail: z.string().email().max(200),
  customerPhone: z.string().min(7).max(30),
  headCount: z.number().int().min(1).max(100_000),
  eventDate: z.string().min(4).max(40),
  fulfillment: z.enum(['PICKUP', 'DELIVERY']),
  deliveryAddress: z.string().max(400).optional(),
  message: z.string().max(4000).optional(),
});

/**
 * The customer-facing catering surface. Tenant resolved from the subdomain by
 * PublicTenantGuard, same as the rest of the storefront.
 */
@ApiTags('storefront')
@Controller('storefront/catering')
@Public()
@UseGuards(PublicTenantGuard)
export class CateringPublicController {
  constructor(private readonly catering: CateringService) {}

  /** Is catering on for this restaurant, and its live packages. */
  @Get()
  offering(@TenantId() restaurantId: string) {
    return this.catering.publicOffering(restaurantId);
  }

  /** Submit a package order (→ checkoutUrl to pay) or a custom enquiry (→ lead). */
  @Post('request')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  submit(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(submitSchema)) body: z.infer<typeof submitSchema>,
  ) {
    return this.catering.submitRequest(restaurantId, body);
  }
}
