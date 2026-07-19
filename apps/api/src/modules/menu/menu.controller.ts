import {
  BadRequestException,
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
import { Throttle } from '@nestjs/throttler';
import { categorySchema, productSchema, type CategoryInput, type ProductInput } from '@dinedirect/shared';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, Roles, TenantId } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { MenuImportService } from './menu-import.service';
import { MenuService } from './menu.service';

const reorderSchema = z.object({ orderedIds: z.array(z.string().cuid()).min(1).max(500) });
const availabilitySchema = z.object({ isAvailable: z.boolean() });
const importUrlSchema = z.object({ url: z.string().min(8).max(500) });
const aiDescriptionSchema = z.object({
  name: z.string().min(1).max(120),
  categoryName: z.string().max(80).optional(),
  /** English, French, or both (two lines). Defaults to English. */
  language: z.enum(['EN', 'FR', 'BOTH']).default('EN'),
});
const aiBrandSchema = z.object({
  /** A one-line brief: cuisine, vibe, neighbourhood. Optional — the model can wing it. */
  brief: z.string().max(200).optional(),
});

/** Staff-only menu management. Storefront reads live in StorefrontController. */
@ApiTags('menu')
@Controller('menu')
@UseGuards(ClerkAuthGuard)
export class MenuController {
  constructor(
    private readonly menu: MenuService,
    private readonly menuImport: MenuImportService,
  ) {}

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

  // --- Import from photo ------------------------------------------------------

  /**
   * Can this deployment read menus from photos at all? The dashboard asks before
   * rendering the button — a button that always errors is worse than no button.
   */
  @Get('import/availability')
  importAvailability() {
    return { available: this.menuImport.available };
  }

  /**
   * One menu photo in, a structured DRAFT out. Nothing is written: the owner
   * reviews and edits the draft in the dashboard, and approved items are created
   * through the same validated category/product endpoints manual entry uses.
   *
   * MANAGER-gated like every other menu write, even though this one doesn't write —
   * it spends real money per call (a vision model reads the image), and the person
   * allowed to spend it is the person allowed to change the menu.
   */
  @Post('import/photo')
  @Roles('MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @Audit('menu.import.extracted', 'Menu')
  async importFromPhoto(
    @TenantId() restaurantId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Attach a photo of the menu as "file"');

    const restaurant = await this.menu.getRestaurantCurrency(restaurantId);
    return this.menuImport.extractFromPhoto(file, restaurant.currency);
  }

  /**
   * Same contract as import/photo, different ingestion: the menu already lives on
   * a web page (their old website, a Google Sites page). Returns the same DRAFT.
   */
  @Post('import/url')
  @Roles('MANAGER')
  @Audit('menu.import.extracted', 'Menu')
  async importFromUrl(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(importUrlSchema)) body: { url: string },
  ) {
    const restaurant = await this.menu.getRestaurantCurrency(restaurantId);
    return this.menuImport.extractFromUrl(body.url, restaurant.currency);
  }

  /**
   * One sentence, written from just the item name and its category -- for the
   * single "AI fill" button on one item, and for the bulk sweep across every
   * item missing a description. Free OpenRouter models, same ladder as import.
   */
  @Post('ai-description')
  @Roles('MANAGER')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async aiDescription(@Body(new ZodValidationPipe(aiDescriptionSchema)) body: z.infer<typeof aiDescriptionSchema>) {
    const description = await this.menuImport.generateDescription(
      body.name,
      body.categoryName ?? null,
      body.language,
    );
    return { description };
  }

  /**
   * Translate the whole menu to French (fills any missing French, never overwrites).
   *
   * Runs in the BACKGROUND and returns immediately: a real menu is dozens of strings,
   * and awaiting all of them would blow past the HTTP timeout and leave it half done.
   * The storefront picks up each batch as its cache is invalidated. Idempotent, so a
   * second press safely fills anything the first run's rate limit missed.
   */
  @Post('translate-french')
  @Roles('MANAGER')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  translateFrench(@TenantId() restaurantId: string) {
    void this.menu.translateMenuToFrench(restaurantId).catch(() => {});
    return { started: true };
  }

  /** Is AI configured, and how much of the menu actually has French stored. */
  @Get('translation-status')
  @Roles('MANAGER')
  translationStatus(@TenantId() restaurantId: string) {
    return this.menu.translationStatus(restaurantId);
  }

  /**
   * A few AI brand ideas (name + monogram spec) from a one-line brief, for the
   * branding editor. Free OpenRouter text models; the web renders each as an SVG.
   */
  @Post('ai-brand')
  @Roles('MANAGER')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  async aiBrand(@Body(new ZodValidationPipe(aiBrandSchema)) body: z.infer<typeof aiBrandSchema>) {
    return { ideas: await this.menuImport.generateBrandIdeas(body.brief ?? '') };
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
