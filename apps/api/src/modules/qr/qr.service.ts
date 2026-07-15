import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QRCodeType } from '@prisma/client';
import * as QRCodeLib from 'qrcode';
import sharp from 'sharp';
import type { QRCodeInput } from '@dinedirect/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { storefrontBaseUrl } from '../../common/tenant-url';
import { StorageService } from '../storage/storage.service';

/**
 * Per-type rendering. A table tent is scanned from 30cm away; a flyer taped to a
 * window is scanned from two metres, so it needs more physical size and a higher
 * error-correction level to survive being printed badly and rained on.
 */
const RENDER_PRESETS: Record<QRCodeType, { width: number; margin: number; ecc: 'M' | 'Q' | 'H' }> = {
  TABLE: { width: 600, margin: 2, ecc: 'M' },
  COUNTER: { width: 800, margin: 3, ecc: 'Q' },
  FLYER: { width: 1200, margin: 4, ecc: 'H' },
};

/** Restaurant names and labels are user input and land in printed HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

@Injectable()
export class QrService {
  private readonly logger = new Logger(QrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  async list(restaurantId: string) {
    return this.prisma.qRCode.findMany({
      where: { restaurantId },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Mint a QR code.
   *
   * The encoded URL carries the code's own id (`?c=<id>`), which is what makes
   * scan attribution possible: when the storefront loads with that param it pings
   * `registerScan`, so the owner can see that the window flyer outperforms the
   * table tents. A TABLE code also carries `?t=<number>` so the cart pre-fills the
   * table and the runner knows where to take the food.
   */
  async create(restaurantId: string, input: QRCodeInput) {
    if (input.type === 'TABLE' && !input.tableNumber) {
      throw new BadRequestException('A table QR code needs a table number');
    }

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { slug: true, dineInEnabled: true },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    if (input.type === 'TABLE' && !restaurant.dineInEnabled) {
      throw new BadRequestException(
        'Turn on dine-in before creating table codes, or orders from them will be rejected',
      );
    }

    // Create first with a placeholder URL: we need the row's id to embed in the
    // link, so the URL can only be built after the insert.
    const qr = await this.prisma.qRCode.create({
      data: {
        restaurantId,
        type: input.type,
        label: input.label,
        tableNumber: input.tableNumber,
        targetUrl: '',
      },
    });

    const targetUrl = this.buildTargetUrl(restaurant.slug, qr.id, input);
    const imageUrl = await this.render(restaurantId, qr.id, targetUrl, input.type);

    return this.prisma.qRCode.update({
      where: { id: qr.id },
      data: { targetUrl, imageUrl },
    });
  }

  /**
   * Create table codes 1..N in one go.
   *
   * A restaurant with 24 tables is not going to fill in a form 24 times, and if we
   * make them, they simply won't set up dine-in at all. This is the difference
   * between a feature that exists and a feature that gets used.
   *
   * Idempotent per table number: re-running it for a bigger dining room adds the
   * new tables and leaves the existing codes (already printed and on the tables!)
   * exactly as they are.
   */
  async createTableRange(restaurantId: string, from: number, to: number) {
    if (to < from) throw new BadRequestException('The last table must be after the first');
    if (to - from + 1 > 100) {
      throw new BadRequestException('That is more than 100 tables — create them in batches');
    }

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { slug: true, dineInEnabled: true },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    if (!restaurant.dineInEnabled) {
      throw new BadRequestException(
        'Turn on dine-in first, or orders from these codes will be rejected',
      );
    }

    const existing = await this.prisma.qRCode.findMany({
      where: { restaurantId, type: 'TABLE' },
      select: { tableNumber: true },
    });
    const taken = new Set(existing.map((q) => q.tableNumber));

    const created = [];
    for (let n = from; n <= to; n++) {
      const tableNumber = String(n);
      if (taken.has(tableNumber)) continue; // already printed and on a table

      const input: QRCodeInput = {
        type: 'TABLE',
        label: `Table ${n}`,
        tableNumber,
      };

      const qr = await this.prisma.qRCode.create({
        data: { restaurantId, type: 'TABLE', label: input.label, tableNumber, targetUrl: '' },
      });

      const targetUrl = this.buildTargetUrl(restaurant.slug, qr.id, input);
      const imageUrl = await this.render(restaurantId, qr.id, targetUrl, 'TABLE');

      created.push(
        await this.prisma.qRCode.update({
          where: { id: qr.id },
          data: { targetUrl, imageUrl },
        }),
      );
    }

    this.logger.log(`Created ${created.length} table QR code(s) for ${restaurant.slug}`);
    return { created: created.length, skipped: to - from + 1 - created.length, codes: created };
  }

  /**
   * The starter set, generated when a restaurant publishes.
   *
   * Nobody sets up QR ordering by choosing between "counter", "flyer" and "table"
   * on an empty screen — they don't yet know what those mean. Giving them a
   * counter code and a flyer code that already work, on the day they go live, is
   * how the feature gets adopted instead of ignored.
   *
   * Silent no-op if they already have codes: never trample a restaurant's own setup.
   */
  async ensureStarterCodes(restaurantId: string): Promise<void> {
    const existing = await this.prisma.qRCode.count({ where: { restaurantId } });
    if (existing > 0) return;

    try {
      await this.create(restaurantId, {
        type: 'COUNTER',
        label: 'Counter / till',
      });
      await this.create(restaurantId, {
        type: 'FLYER',
        label: 'Window & flyers',
      });
      this.logger.log(`Created starter QR codes for restaurant ${restaurantId}`);
    } catch (err) {
      // A QR code is not worth failing a publish over. The owner can make them
      // by hand, and the publish is the thing that actually matters.
      this.logger.warn(`Could not create starter QR codes: ${(err as Error).message}`);
    }
  }

  private buildTargetUrl(slug: string, qrId: string, input: QRCodeInput): string {
    // Printed on paper, lives on tables for years -- it MUST encode a URL that
    // resolves on THIS deployment. See common/tenant-url.ts.
    const base = storefrontBaseUrl(this.config, slug);

    const params = new URLSearchParams({ src: 'qr', c: qrId });
    if (input.type === 'TABLE' && input.tableNumber) {
      params.set('t', input.tableNumber);
    }
    return `${base}/menu?${params.toString()}`;
  }

  private async render(
    restaurantId: string,
    qrId: string,
    targetUrl: string,
    type: QRCodeType,
  ): Promise<string | null> {
    const preset = RENDER_PRESETS[type];
    try {
      const png = await QRCodeLib.toBuffer(targetUrl, {
        type: 'png',
        width: preset.width,
        margin: preset.margin,
        errorCorrectionLevel: preset.ecc,
        color: { dark: '#000000', light: '#FFFFFF' },
      });

      const { url } = await this.storage.upload(png, 'image/png', `restaurants/${restaurantId}/qr`);
      return url;
    } catch (err) {
      // A missing PNG is recoverable — the code still works, and `regenerate`
      // can re-render it. Don't fail the whole creation over it.
      this.logger.error(`Failed to render QR ${qrId}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Branded PNG for the dashboard's download button -- the restaurant's own
   * logo and name, not a bare matrix. This is the file an owner prints and
   * tapes to a table; a code with no identity on it looks like it fell off
   * a delivery-app truck, which is the exact opposite of the point.
   */
  async downloadPng(restaurantId: string, id: string): Promise<{ buffer: Buffer; filename: string }> {
    const { qr, restaurant } = await this.loadQrAndBranding(restaurantId, id);
    const svg = await this.buildBrandedSvg(qr, restaurant);
    const buffer = await sharp(Buffer.from(svg)).png().toBuffer();

    const safeLabel = qr.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { buffer, filename: `qr-${qr.type.toLowerCase()}-${safeLabel || qr.id}.png` };
  }

  /** Same branded card, as vector art for print shops doing large-format flyers. */
  async downloadSvg(restaurantId: string, id: string): Promise<{ svg: string; filename: string }> {
    const { qr, restaurant } = await this.loadQrAndBranding(restaurantId, id);
    const svg = await this.buildBrandedSvg(qr, restaurant);

    const safeLabel = qr.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { svg, filename: `qr-${qr.type.toLowerCase()}-${safeLabel || qr.id}.svg` };
  }

  private async loadQrAndBranding(restaurantId: string, id: string) {
    const [qr, restaurant] = await Promise.all([
      this.prisma.qRCode.findFirst({ where: { id, restaurantId } }),
      this.prisma.restaurant.findUniqueOrThrow({
        where: { id: restaurantId },
        select: { name: true, logoUrl: true, brandPrimaryColor: true, brandAccentColor: true },
      }),
    ]);
    if (!qr) throw new NotFoundException('QR code not found');
    return { qr, restaurant };
  }

  /** A restaurant's logo, inlined as a data URI so it survives inside a standalone SVG/PNG. */
  private async fetchAsDataUri(url: string): Promise<string | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return null;
      const contentType = res.headers.get('content-type') ?? 'image/png';
      const buffer = Buffer.from(await res.arrayBuffer());
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch {
      // A logo that fails to fetch falls back to the initial-in-a-circle mark
      // below -- never worth failing the whole download over.
      return null;
    }
  }

  /**
   * The single-card branded design: logo/name, "Scan to order", the QR framed
   * in the brand colour, and the table/counter label -- the same visual
   * language as the print sheet's tents, at the scale of one downloadable file.
   */
  private async buildBrandedSvg(
    qr: { type: QRCodeType; label: string; tableNumber: string | null; targetUrl: string },
    restaurant: { name: string; logoUrl: string | null; brandPrimaryColor: string; brandAccentColor: string },
  ): Promise<string> {
    const preset = RENDER_PRESETS[qr.type];
    const qrPng = await QRCodeLib.toBuffer(qr.targetUrl, {
      type: 'png',
      width: 560,
      margin: 1,
      errorCorrectionLevel: preset.ecc,
      color: { dark: '#000000', light: '#ffffff' },
    });
    const qrDataUri = `data:image/png;base64,${qrPng.toString('base64')}`;
    const logoDataUri = restaurant.logoUrl ? await this.fetchAsDataUri(restaurant.logoUrl) : null;

    const heading =
      qr.type === 'TABLE' ? `Table ${escapeHtml(qr.tableNumber ?? '')}` : escapeHtml(qr.label);

    const W = 640;
    const qrSize = 460;
    const qrX = (W - qrSize) / 2;
    const qrY = 214;
    const H = qrY + qrSize + 130;

    const mark = logoDataUri
      ? `<clipPath id="logoClip"><rect x="${W / 2 - 28}" y="44" width="56" height="56" rx="16" /></clipPath>
         <image href="${logoDataUri}" x="${W / 2 - 28}" y="44" width="56" height="56" clip-path="url(#logoClip)" preserveAspectRatio="xMidYMid slice" />`
      : `<rect x="${W / 2 - 28}" y="44" width="56" height="56" rx="16" fill="${restaurant.brandPrimaryColor}" />
         <text x="${W / 2}" y="80" font-family="Georgia, serif" font-size="26" font-weight="700" fill="#ffffff" text-anchor="middle">${escapeHtml(restaurant.name.charAt(0))}</text>`;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${restaurant.brandPrimaryColor}" />
      <stop offset="1" stop-color="${restaurant.brandAccentColor}" />
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" rx="36" fill="#ffffff" />
  <rect width="${W}" height="14" rx="7" fill="url(#bar)" />
  ${mark}
  <text x="${W / 2}" y="136" font-family="-apple-system, Segoe UI, Roboto, sans-serif" font-size="15" font-weight="700" letter-spacing="2" fill="${restaurant.brandPrimaryColor}" text-anchor="middle">${escapeHtml(restaurant.name.toUpperCase())}</text>
  <text x="${W / 2}" y="182" font-family="Georgia, 'Times New Roman', serif" font-size="34" font-weight="600" fill="#1c1917" text-anchor="middle">Scan to order</text>
  <rect x="${qrX - 16}" y="${qrY - 16}" width="${qrSize + 32}" height="${qrSize + 32}" rx="24" fill="#ffffff" stroke="${restaurant.brandPrimaryColor}" stroke-width="2" />
  <image href="${qrDataUri}" x="${qrX}" y="${qrY}" width="${qrSize}" height="${qrSize}" />
  <text x="${W / 2}" y="${qrY + qrSize + 58}" font-family="-apple-system, Segoe UI, Roboto, sans-serif" font-size="26" font-weight="700" fill="#1c1917" text-anchor="middle">${heading}</text>
  <text x="${W / 2}" y="${qrY + qrSize + 90}" font-family="-apple-system, Segoe UI, Roboto, sans-serif" font-size="14" fill="#78716c" text-anchor="middle">Point your phone camera at the code</text>
</svg>`;
  }

  /**
   * Count a scan. Called by the storefront when it loads with `?c=<id>`.
   *
   * Fire-and-forget and deliberately unauthenticated — it's an analytics ping, and
   * the worst an abuser can do is inflate a vanity number. It must never slow the
   * menu down or fail the page load, so all errors are swallowed.
   */
  async registerScan(qrId: string): Promise<void> {
    try {
      await this.prisma.qRCode.update({
        where: { id: qrId },
        data: { scanCount: { increment: 1 }, lastScanAt: new Date() },
      });
    } catch {
      // Unknown id (stale printed code, someone poking the endpoint). Ignore.
    }
  }

  async setActive(restaurantId: string, id: string, isActive: boolean) {
    const qr = await this.prisma.qRCode.findFirst({ where: { id, restaurantId } });
    if (!qr) throw new NotFoundException('QR code not found');
    return this.prisma.qRCode.update({ where: { id }, data: { isActive } });
  }

  async remove(restaurantId: string, id: string) {
    const qr = await this.prisma.qRCode.findFirst({ where: { id, restaurantId } });
    if (!qr) throw new NotFoundException('QR code not found');

    // Deleting a code whose printed copies are on live tables would silently
    // break them. Deactivate instead — the row stays, orders keep resolving.
    const orderCount = await this.prisma.order.count({ where: { qrCodeId: id } });
    if (orderCount > 0) {
      throw new BadRequestException(
        `This code has ${orderCount} order(s) attributed to it. Deactivate it instead of deleting.`,
      );
    }

    await this.prisma.qRCode.delete({ where: { id } });
  }

  /**
   * A print-ready sheet of table tents / counter cards.
   *
   * The QR codes are inlined as data URIs rather than linked, so the sheet prints
   * correctly even if the browser's print renderer skips remote images (it often
   * does) and works with no network at all. A print sheet that comes out with four
   * broken-image icons is worse than no print sheet.
   */
  async buildPrintSheet(restaurantId: string, type?: QRCodeType): Promise<string> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        name: true,
        logoUrl: true,
        brandPrimaryColor: true,
        brandAccentColor: true,
        phone: true,
        street: true,
        city: true,
        slug: true,
      },
    });
    if (!restaurant) throw new NotFoundException('Restaurant not found');

    const codes = await this.prisma.qRCode.findMany({
      where: { restaurantId, isActive: true, ...(type ? { type } : {}) },
      orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
    });

    if (codes.length === 0) {
      throw new BadRequestException('You have no QR codes to print yet');
    }

    const tents = await Promise.all(
      codes.map(async (code) => {
        const png = await QRCodeLib.toDataURL(code.targetUrl, {
          width: 600,
          margin: 1,
          errorCorrectionLevel: 'Q',
        });

        const heading =
          code.type === 'TABLE'
            ? `Table ${escapeHtml(code.tableNumber ?? '')}`
            : escapeHtml(code.label);

        const mark = restaurant.logoUrl
          ? `<img src="${escapeHtml(restaurant.logoUrl)}" alt="" class="logo" />`
          : `<span class="logo logo-fallback">${escapeHtml(restaurant.name.charAt(0))}</span>`;

        return `
        <div class="tent">
          <div class="tent-inner">
            <div class="brand-row">
              ${mark}
              <p class="restaurant">${escapeHtml(restaurant.name)}</p>
            </div>
            <p class="headline">Scan to order</p>
            <div class="qr-frame"><img src="${png}" alt="" class="qr" /></div>
            <p class="table">${heading}</p>
            <p class="hint">Point your phone camera at the code — no app needed.</p>
            <div class="foot">
              <span>${escapeHtml(restaurant.street)}, ${escapeHtml(restaurant.city)}</span>
              <span>·</span>
              <span>${escapeHtml(restaurant.phone)}</span>
            </div>
          </div>
        </div>`;
      }),
    );

    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(restaurant.name)} — QR codes to print</title>
    <style>
      /* A4 with a real margin; four tents to a page. */
      @page { size: A4; margin: 12mm; }

      * { box-sizing: border-box; margin: 0; padding: 0; }

      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        color: #1c1917;
        background: #f5f5f4;
      }

      .toolbar {
        position: sticky; top: 0; z-index: 10;
        display: flex; align-items: center; justify-content: space-between; gap: 16px;
        padding: 16px 24px;
        background: #fff;
        border-bottom: 1px solid #e7e5e4;
      }
      .toolbar h1 { font-size: 16px; font-weight: 600; }
      .toolbar p { font-size: 13px; color: #78716c; }
      .toolbar button {
        background: ${escapeHtml(restaurant.brandPrimaryColor)};
        color: #fff; border: 0; border-radius: 10px;
        padding: 10px 20px; font-size: 14px; font-weight: 600; cursor: pointer;
      }

      .sheet {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8mm;
        padding: 24px;
        max-width: 900px;
        margin: 0 auto;
      }

      .tent {
        /* The dashed outline is the cut line; the brand bar and shadow are the
           design. Real corner radius so this reads as a printed card, not a
           spreadsheet cell. */
        position: relative;
        border: 1px dashed #d6d3d1;
        border-radius: 7mm;
        background: #fff;
        padding: 0;
        overflow: hidden;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.04);
        break-inside: avoid;   /* never split a tent across two pages */
        page-break-inside: avoid;
      }
      .tent::before {
        content: '';
        display: block;
        height: 4mm;
        background: linear-gradient(90deg, ${escapeHtml(restaurant.brandPrimaryColor)}, ${escapeHtml(restaurant.brandAccentColor)});
      }

      .tent-inner { text-align: center; padding: 7mm 6mm 6mm; }

      .brand-row { display: flex; align-items: center; justify-content: center; gap: 2.5mm; }
      .logo {
        width: 9mm; height: 9mm; border-radius: 3mm; object-fit: cover;
        border: 1px solid #eeeceb;
      }
      .logo-fallback {
        display: flex; align-items: center; justify-content: center;
        background: ${escapeHtml(restaurant.brandPrimaryColor)};
        color: #fff; font-size: 12px; font-weight: 700;
      }
      .restaurant {
        font-size: 12px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase;
        color: ${escapeHtml(restaurant.brandPrimaryColor)};
        white-space: nowrap;
      }
      .headline {
        margin-top: 5mm; font-size: 30px; font-weight: 600; letter-spacing: -.02em;
        font-family: Georgia, 'Times New Roman', serif;
      }
      .qr-frame {
        display: inline-block; margin: 5mm auto 4mm; padding: 3mm;
        background: #fff;
        border: 1.5px solid ${escapeHtml(restaurant.brandPrimaryColor)};
        border-radius: 6mm;
      }
      .qr { width: 42mm; height: 42mm; display: block; border-radius: 2mm; }
      .table {
        display: inline-block;
        font-size: 18px; font-weight: 700;
        padding: 1.5mm 5mm; border-radius: 999px;
        background: color-mix(in srgb, ${escapeHtml(restaurant.brandPrimaryColor)} 10%, transparent);
        color: ${escapeHtml(restaurant.brandPrimaryColor)};
      }
      .hint { margin-top: 4mm; font-size: 10.5px; line-height: 1.5; color: #78716c; }
      .foot {
        display: flex; justify-content: center; gap: 2mm;
        margin-top: 5mm; padding-top: 3mm; border-top: 1px solid #f0efed;
        font-size: 9.5px; color: #a8a29e;
      }

      @media print {
        .toolbar { display: none; }
        body { background: #fff; }
        .sheet { padding: 0; gap: 6mm; max-width: none; }
      }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <div>
        <h1>${codes.length} QR code${codes.length === 1 ? '' : 's'} ready to print</h1>
        <p>Print, cut along the dashed lines, and fold or stand them on your tables.</p>
      </div>
      <button onclick="window.print()">Print</button>
    </div>

    <div class="sheet">
      ${tents.join('\n')}
    </div>
  </body>
</html>`;
  }

  /** Which codes actually bring people in. The reason we attribute scans at all. */
  async getScanStats(restaurantId: string) {
    const codes = await this.prisma.qRCode.findMany({
      where: { restaurantId },
      select: {
        id: true,
        label: true,
        type: true,
        scanCount: true,
        lastScanAt: true,
        _count: { select: { orders: true } },
      },
      orderBy: { scanCount: 'desc' },
    });

    return codes.map((c) => ({
      id: c.id,
      label: c.label,
      type: c.type,
      scans: c.scanCount,
      orders: c._count.orders,
      /** Scans that turned into orders. The only number that matters here. */
      conversionRate: c.scanCount > 0 ? Math.round((c._count.orders / c.scanCount) * 100) : 0,
      lastScanAt: c.lastScanAt,
    }));
  }
}
