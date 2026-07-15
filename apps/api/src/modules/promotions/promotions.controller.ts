import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { promotionSchema, type PromotionInput } from '@dinedirect/shared';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, Roles, TenantId } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { PromotionsService } from './promotions.service';

const activeSchema = z.object({ isActive: z.boolean() });

@ApiTags('promotions')
@Controller('promotions')
@UseGuards(ClerkAuthGuard)
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  list(@TenantId() restaurantId: string) {
    return this.promotions.list(restaurantId);
  }

  @Post()
  @Roles('MANAGER')
  @Audit('promotion.created', 'Promotion')
  create(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(promotionSchema)) body: PromotionInput,
  ) {
    return this.promotions.create(restaurantId, body);
  }

  @Patch(':id/active')
  @Roles('MANAGER')
  @Audit('promotion.active_changed', 'Promotion')
  setActive(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: { isActive: boolean },
  ) {
    return this.promotions.setActive(restaurantId, id, body.isActive);
  }

  @Delete(':id')
  @Roles('MANAGER')
  @Audit('promotion.deleted', 'Promotion')
  async remove(@TenantId() restaurantId: string, @Param('id') id: string) {
    await this.promotions.remove(restaurantId, id);
    return { success: true };
  }
}
