import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { CurrentUser, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { CateringService } from './catering.service';

const packageSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullish(),
  imageUrl: z.string().url().max(600).nullish(),
  pricePerPersonCents: z.number().int().min(0).max(10_000_000),
  minPeople: z.number().int().min(1).max(100_000).optional(),
  maxPeople: z.number().int().min(1).max(100_000).nullish(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
const packageUpdateSchema = packageSchema.partial();

const statusSchema = z.object({
  status: z.enum(['NEW', 'IN_PROGRESS', 'CONFIRMED', 'COMPLETED', 'CANCELLED']),
});

/** Staff-only catering management: packages and the enquiry inbox. */
@ApiTags('catering')
@Controller('catering')
@UseGuards(ClerkAuthGuard)
export class CateringController {
  constructor(private readonly catering: CateringService) {}

  @Get('packages')
  @Roles('MANAGER')
  listPackages(@TenantId() restaurantId: string) {
    return this.catering.listPackages(restaurantId);
  }

  @Post('packages')
  @Roles('MANAGER')
  createPackage(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(packageSchema)) body: z.infer<typeof packageSchema>,
  ) {
    return this.catering.createPackage(restaurantId, body, user.id);
  }

  @Patch('packages/:id')
  @Roles('MANAGER')
  updatePackage(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(packageUpdateSchema)) body: z.infer<typeof packageUpdateSchema>,
  ) {
    return this.catering.updatePackage(restaurantId, id, body, user.id);
  }

  @Delete('packages/:id')
  @Roles('MANAGER')
  deletePackage(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    return this.catering.deletePackage(restaurantId, id, user.id);
  }

  @Get('requests')
  @Roles('MANAGER')
  listRequests(@TenantId() restaurantId: string) {
    return this.catering.listRequests(restaurantId);
  }

  @Patch('requests/:id/status')
  @Roles('MANAGER')
  updateStatus(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(statusSchema)) body: z.infer<typeof statusSchema>,
  ) {
    return this.catering.updateRequestStatus(restaurantId, id, body.status, user.id);
  }
}
