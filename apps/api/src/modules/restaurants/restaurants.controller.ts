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
  UnauthorizedException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags } from '@nestjs/swagger';
import {
  createRestaurantSchema,
  deliverySettingsSchema,
  updateRestaurantSchema,
  type CreateRestaurantInput,
  type DeliverySettingsInput,
  type StaffRole,
  type UpdateRestaurantInput,
} from '@orderos/shared';
import { z } from 'zod';
import { StaffInvitesService } from './staff-invites.service';

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['OWNER', 'MANAGER', 'STAFF']),
});
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { ClerkService } from '../../common/auth/clerk.service';
import { Audit, CurrentUser, Public, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { RestaurantsService } from './restaurants.service';
import type { Request } from 'express';
import { Req } from '@nestjs/common';

@ApiTags('restaurants')
@Controller('restaurants')
@UseGuards(ClerkAuthGuard)
export class RestaurantsController {
  constructor(
    private readonly restaurants: RestaurantsService,
    private readonly clerk: ClerkService,
    private readonly invites: StaffInvitesService,
  ) {}

  /**
   * Onboarding step 1. @Public because the caller has a Clerk account but no
   * membership yet — ClerkAuthGuard would reject them for having no tenant. We
   * verify the Clerk token by hand here instead.
   */
  @Post()
  @Public()
  async create(
    @Req() req: Request,
    @Body(new ZodValidationPipe(createRestaurantSchema)) body: CreateRestaurantInput,
  ) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const claims = await this.clerk.verifySessionToken(header.slice(7));
    if (!claims) throw new UnauthorizedException('Invalid session');

    return this.restaurants.create(claims.sub, body);
  }

  /** Restaurants the caller is staff at. Also @Public for the same reason as above. */
  @Get('mine')
  @Public()
  async mine(@Req() req: Request) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');
    const claims = await this.clerk.verifySessionToken(header.slice(7));
    if (!claims) throw new UnauthorizedException('Invalid session');

    return this.restaurants.listForUser(claims.sub);
  }

  @Get('slug-available')
  @Public()
  async slugAvailable(@Query('slug') slug: string) {
    return { available: await this.restaurants.isSlugAvailable((slug ?? '').toLowerCase()) };
  }

  @Get('current')
  async current(@TenantId() restaurantId: string) {
    return this.restaurants.findById(restaurantId);
  }

  @Patch('current')
  @Roles('MANAGER')
  @Audit('restaurant.updated', 'Restaurant')
  async update(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(updateRestaurantSchema)) body: UpdateRestaurantInput,
  ) {
    return this.restaurants.update(restaurantId, body, user.id);
  }

  @Patch('current/delivery-settings')
  @Roles('MANAGER')
  @Audit('restaurant.delivery_settings_updated', 'Restaurant')
  async updateDelivery(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(deliverySettingsSchema)) body: DeliverySettingsInput,
  ) {
    return this.restaurants.updateDeliverySettings(restaurantId, body, user.id);
  }

  @Post('current/logo')
  @Roles('MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @Audit('restaurant.logo_uploaded', 'Restaurant')
  async uploadLogo(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.restaurants.uploadLogo(restaurantId, file, user.id);
  }

  @Post('current/cover')
  @Roles('MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  async uploadCover(
    @TenantId() restaurantId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.restaurants.uploadCover(restaurantId, file);
  }

  // --- About page gallery ----------------------------------------------------

  @Get('current/gallery')
  listGallery(@TenantId() restaurantId: string) {
    return this.restaurants.listGallery(restaurantId);
  }

  @Post('current/gallery')
  @Roles('MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @Audit('restaurant.gallery_image_added', 'GalleryImage')
  addGalleryImage(
    @TenantId() restaurantId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body('caption') caption?: string,
  ) {
    return this.restaurants.addGalleryImage(restaurantId, file, caption);
  }

  @Delete('current/gallery/:id')
  @Roles('MANAGER')
  @Audit('restaurant.gallery_image_removed', 'GalleryImage')
  removeGalleryImage(@TenantId() restaurantId: string, @Param('id') id: string) {
    return this.restaurants.removeGalleryImage(restaurantId, id);
  }

  @Get('current/publish-readiness')
  async readiness(@TenantId() restaurantId: string) {
    return this.restaurants.getPublishReadiness(restaurantId);
  }

  /**
   * Mint a 30-minute preview link for an UNPUBLISHED storefront. Any staff member
   * may look; looking is harmless and the alternative was that nobody could.
   */
  @Post('current/preview-link')
  async previewLink(@TenantId() restaurantId: string) {
    return this.restaurants.createPreviewLink(restaurantId);
  }

  @Post('current/publish')
  @Roles('OWNER')
  @Audit('restaurant.published', 'Restaurant')
  async publish(@TenantId() restaurantId: string, @CurrentUser() user: AuthUser) {
    return this.restaurants.publish(restaurantId, user.id);
  }

  @Post('current/unpublish')
  @Roles('OWNER')
  @Audit('restaurant.unpublished', 'Restaurant')
  async unpublish(@TenantId() restaurantId: string, @CurrentUser() user: AuthUser) {
    return this.restaurants.unpublish(restaurantId, user.id);
  }

  // --- Staff ----------------------------------------------------------------

  @Get('current/staff')
  @Roles('MANAGER')
  async listStaff(@TenantId() restaurantId: string) {
    return this.restaurants.listStaff(restaurantId);
  }

  @Patch('current/staff/:id/role')
  @Roles('OWNER')
  @Audit('staff.role_changed', 'User')
  async updateStaffRole(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') targetId: string,
    @Body('role') role: 'OWNER' | 'MANAGER' | 'STAFF',
  ) {
    return this.restaurants.updateStaffRole(restaurantId, targetId, role, user.id);
  }

  @Delete('current/staff/:id')
  @Roles('OWNER')
  @Audit('staff.removed', 'User')
  async removeStaff(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') targetId: string,
  ) {
    await this.restaurants.removeStaff(restaurantId, targetId, user.id);
    return { success: true };
  }

  // --- Invitations ----------------------------------------------------------

  @Get('current/invites')
  @Roles('MANAGER')
  listInvites(@TenantId() restaurantId: string) {
    return this.invites.list(restaurantId);
  }

  @Post('current/invites')
  @Roles('MANAGER')
  @Audit('staff.invited', 'StaffInvite')
  invite(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(inviteSchema)) body: { email: string; role: StaffRole },
  ) {
    // The acting user's role is passed through so the service can refuse a
    // MANAGER trying to mint an OWNER — a privilege-escalation path if unchecked.
    return this.invites.create(restaurantId, body, { id: user.id, role: user.role });
  }

  @Delete('current/invites/:id')
  @Roles('MANAGER')
  @Audit('staff.invite_revoked', 'StaffInvite')
  async revokeInvite(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.invites.revoke(restaurantId, id, user.id);
    return { success: true };
  }
}

/**
 * Invite acceptance. Separate controller because these routes CANNOT sit behind
 * ClerkAuthGuard's membership check — the whole point is that the caller has no
 * membership yet. The invite token is the authorisation.
 */
@ApiTags('invites')
@Controller('invites')
export class InvitesController {
  constructor(
    private readonly invites: StaffInvitesService,
    private readonly clerk: ClerkService,
  ) {}

  /** What the invitee sees before signing in. No auth: the token is the key. */
  @Get(':token')
  @Public()
  preview(@Param('token') token: string) {
    return this.invites.preview(token);
  }

  /**
   * Accept. @Public because the caller is authenticated with Clerk but is not yet
   * staff anywhere — ClerkAuthGuard would reject them for having no membership,
   * which is precisely the thing they're here to fix. So we verify the Clerk token
   * by hand.
   */
  @Post(':token/accept')
  @Public()
  async accept(@Req() req: Request, @Param('token') token: string) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Sign in to accept');

    const claims = await this.clerk.verifySessionToken(header.slice(7));
    if (!claims) throw new UnauthorizedException('Invalid session');

    return this.invites.accept(token, claims.sub);
  }
}
