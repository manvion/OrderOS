import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { qrCodeSchema, type QRCodeInput } from '@orderos/shared';
import { z } from 'zod';
import { ClerkAuthGuard } from '../../common/auth/clerk-auth.guard';
import { Audit, Public, Roles, TenantId } from '../../common/auth/decorators';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { QrService } from './qr.service';

const activeSchema = z.object({ isActive: z.boolean() });

const tableRangeSchema = z
  .object({
    from: z.number().int().min(1).max(999),
    to: z.number().int().min(1).max(999),
  })
  .refine((r) => r.to >= r.from, {
    message: 'The last table must be the same as or after the first',
    path: ['to'],
  });

@ApiTags('qr')
@Controller('qr')
@UseGuards(ClerkAuthGuard)
export class QrController {
  constructor(private readonly qr: QrService) {}

  @Get()
  list(@TenantId() restaurantId: string) {
    return this.qr.list(restaurantId);
  }

  @Get('stats')
  stats(@TenantId() restaurantId: string) {
    return this.qr.getScanStats(restaurantId);
  }

  @Post()
  @Roles('MANAGER')
  @Audit('qr.created', 'QRCode')
  create(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(qrCodeSchema)) body: QRCodeInput,
  ) {
    return this.qr.create(restaurantId, body);
  }

  /** Tables 1..N in one click. Nobody fills in a form 24 times. */
  @Post('tables')
  @Roles('MANAGER')
  @Audit('qr.tables_created', 'QRCode')
  createTables(
    @TenantId() restaurantId: string,
    @Body(new ZodValidationPipe(tableRangeSchema)) body: { from: number; to: number },
  ) {
    return this.qr.createTableRange(restaurantId, body.from, body.to);
  }

  /**
   * A print-ready sheet of table tents.
   *
   * Returns HTML with @page CSS, sized for A4/Letter, four tents to a page with cut
   * lines. The owner hits Ctrl+P and has their dining room set up — no design tool,
   * no print shop, no exporting individual PNGs and pasting them into Word, which
   * is what they would otherwise actually do.
   */
  @Get('print-sheet')
  @Roles('MANAGER')
  async printSheet(
    @TenantId() restaurantId: string,
    @Query('type') type: 'TABLE' | 'COUNTER' | 'FLYER' | undefined,
    @Res() res: Response,
  ) {
    const html = await this.qr.buildPrintSheet(restaurantId, type);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  @Get(':id/download.png')
  async downloadPng(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.qr.downloadPng(restaurantId, id);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }

  @Get(':id/download.svg')
  async downloadSvg(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const { svg, filename } = await this.qr.downloadSvg(restaurantId, id);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(svg);
  }

  @Patch(':id/active')
  @Roles('MANAGER')
  @Audit('qr.active_changed', 'QRCode')
  setActive(
    @TenantId() restaurantId: string,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: { isActive: boolean },
  ) {
    return this.qr.setActive(restaurantId, id, body.isActive);
  }

  @Delete(':id')
  @Roles('MANAGER')
  @Audit('qr.deleted', 'QRCode')
  async remove(@TenantId() restaurantId: string, @Param('id') id: string) {
    await this.qr.remove(restaurantId, id);
    return { success: true };
  }
}

/**
 * The scan ping, split into its own controller because it must NOT sit behind
 * ClerkAuthGuard — it's called by a customer's browser, from the storefront, with
 * no session of any kind.
 */
@ApiTags('qr')
@Controller('qr-scan')
export class QrScanController {
  constructor(private readonly qr: QrService) {}

  @Post(':id')
  @Public()
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async scan(@Param('id') id: string): Promise<void> {
    await this.qr.registerScan(id);
  }
}
