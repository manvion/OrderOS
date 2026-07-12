import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import { categorySchema, productSchema, type CategoryInput, type ProductInput } from '@orderos/shared';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, Roles, TenantId } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MenuService } from './menu.service';

const reorderSchema = z.object({ orderedIds: z.array(z.string().cuid()).min(1).max(500) });
const availabilitySchema = z.object({ isAvailable: z.boolean() });

/** Staff-only menu management. Storefront reads live in StorefrontController. */
@ApiTags('menu')
@Controller('menu')
@UseGuards(ClerkAuthGuard)
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  // --- Categories -----------------------------------------------------------

  @Get('categories')
  listCategories(@TenantId() restaurantId: string) {
    return this.menu.listCategories(restaurantId);
  }

  @Post('categories')
  @Roles('MANAGER')
  @Audit('menu.category.created', 'Category')
  createCategory(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(categorySchema)) body: CategoryInput,
  ) {
    return this.menu.createCategory(restaurantId, body);
  }

  @Patch('categories/reorder')
  @Roles('MANAGER')
  @Audit('menu.category.reordered', 'Category')
  async reorderCategories(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(reorderSchema)) body: { orderedIds: string[] },
  ) {
    await this.menu.reorderCategories(restaurantId, body.orderedIds);
    return { success: true };
  }

  @Patch('categories/:id')
  @Roles('MANAGER')
  @Audit('menu.category.updated', 'Category')
  updateCategory(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(categorySchema.partial())) body: Partial<CategoryInput>,
  ) {
    return this.menu.updateCategory(restaurantId, id, body);
  }

  @Delete('categories/:id')
  @Roles('MANAGER')
  @Audit('menu.category.deleted', 'Category')
  async deleteCategory(@TenantId() restaurantId: string, @Param('id') id: string) {
    await this.menu.deleteCategory(restaurantId, id);
    return { success: true };
  }

  // --- Products -------------------------------------------------------------

  @Get('products')
  listProducts(@TenantId() restaurantId: string, @Query('categoryId') categoryId?: string) {
    return this.menu.listProducts(restaurantId, categoryId);
  }

  @Get('products/:id')
  getProduct(@TenantId() restaurantId: string, @Param('id') id: string) {
    return this.menu.getProduct(restaurantId, id);
  }

  @Post('products')
  @Roles('MANAGER')
  @Audit('menu.product.created', 'Product')
  createProduct(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(productSchema)) body: ProductInput,
  ) {
    return this.menu.createProduct(restaurantId, body);
  }

  @Patch('products/reorder')
  @Roles('MANAGER')
  async reorderProducts(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(reorderSchema)) body: { orderedIds: string[] },
  ) {
    await this.menu.reorderProducts(restaurantId, body.orderedIds);
    return { success: true };
  }

  /**
   * Availability is STAFF-writable (unlike the rest of the menu, which is
   * MANAGER+): the line cook who runs out of salmon needs to 86 it immediately,
   * and making them find a manager is how you get oversold items.
   */
  @Patch('products/:id/availability')
  @Audit('menu.product.availability_changed', 'Product')
  setAvailability(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(availabilitySchema)) body: { isAvailable: boolean },
  ) {
    return this.menu.setAvailability(restaurantId, id, body.isAvailable);
  }

  @Patch('products/:id')
  @Roles('MANAGER')
  @Audit('menu.product.updated', 'Product')
  updateProduct(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(productSchema.partial())) body: Partial<ProductInput>,
  ) {
    return this.menu.updateProduct(restaurantId, id, body);
  }

  @Post('products/:id/image')
  @Roles('MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @Audit('menu.product.image_uploaded', 'Product')
  uploadImage(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.menu.uploadProductImage(restaurantId, id, file);
  }

  @Delete('products/:id')
  @Roles('MANAGER')
  @Audit('menu.product.deleted', 'Product')
  async deleteProduct(@TenantId() restaurantId: string, @Param('id') id: string) {
    await this.menu.deleteProduct(restaurantId, id);
    return { success: true };
  }
}
