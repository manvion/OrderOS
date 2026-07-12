import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiTags } from '@nestjs/swagger';
import {
  createIntegrationSchema,
  updateIntegrationSchema,
  type CreateIntegrationInput,
  type UpdateIntegrationInput,
} from '@orderos/shared';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, CurrentUser, Roles, TenantId } from '../../common/auth/decorators';
import type { AuthUser } from '../../common/auth/request-context';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { WidgetAnalyticsService } from './widget-analytics.service';
import { WidgetService } from './widget.service';

/** Restaurant-facing management of website integrations. */
@ApiTags('website-integrations')
@Controller('website-integrations')
@UseGuards(ClerkAuthGuard)
export class WidgetAdminController {
  constructor(
    private readonly widget: WidgetService,
    private readonly analytics: WidgetAnalyticsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async list(@TenantId() restaurantId: string) {
    const integrations = await this.widget.list(restaurantId);
    // Hand back the ready-to-paste snippet with each one, so the dashboard never
    // has to reconstruct the CDN URL and get it subtly wrong.
    return integrations.map((integration) => ({
      ...integration,
      embedCode: this.buildSnippet(integration.widgetKey),
    }));
  }

  @Get('analytics')
  @Roles('MANAGER')
  analytics_(@TenantId() restaurantId: string, @Query('days') days?: string) {
    return this.analytics.getFunnel(restaurantId, days ? Number(days) : 30);
  }

  @Post()
  @Roles('MANAGER')
  @Audit('widget.integration_created', 'WebsiteIntegration')
  async create(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createIntegrationSchema)) body: CreateIntegrationInput,
  ) {
    const integration = await this.widget.create(restaurantId, body, user.id);
    return { ...integration, embedCode: this.buildSnippet(integration.widgetKey) };
  }

  @Patch(':id')
  @Roles('MANAGER')
  @Audit('widget.integration_updated', 'WebsiteIntegration')
  async update(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateIntegrationSchema)) body: UpdateIntegrationInput,
  ) {
    const integration = await this.widget.update(restaurantId, id, body, user.id);
    return { ...integration, embedCode: this.buildSnippet(integration.widgetKey) };
  }

  /** OWNER-only: this instantly breaks the live website until they re-paste the snippet. */
  @Post(':id/rotate-key')
  @Roles('OWNER')
  @Audit('widget.key_rotated', 'WebsiteIntegration')
  async rotate(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    const integration = await this.widget.rotateKey(restaurantId, id, user.id);
    return { ...integration, embedCode: this.buildSnippet(integration.widgetKey) };
  }

  @Delete(':id')
  @Roles('MANAGER')
  @Audit('widget.integration_deleted', 'WebsiteIntegration')
  async remove(
    @TenantId() restaurantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ) {
    await this.widget.remove(restaurantId, id, user.id);
    return { success: true };
  }

  /**
   * The snippet the owner pastes. Two attributes, no configuration — everything
   * else is set in the dashboard and fetched at runtime, so changing the button
   * colour never requires the restaurant to edit their website again.
   */
  private buildSnippet(widgetKey: string): string {
    const cdnUrl = this.config.get<string>('WIDGET_CDN_URL') ?? `${this.config.getOrThrow<string>('WEB_URL')}/widget.js`;
    return `<script src="${cdnUrl}" data-orderos-key="${widgetKey}" defer></script>`;
  }
}
