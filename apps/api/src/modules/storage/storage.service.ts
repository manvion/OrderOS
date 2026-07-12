import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
]);

/**
 * Azure Blob Storage for logos, product images and rendered QR PNGs.
 *
 * Falls back to writing under ./uploads when no connection string is set, so the
 * whole app is runnable locally with no Azure account. The fallback is refused in
 * production — silently writing customer logos to a container's ephemeral disk is
 * exactly the kind of thing that looks fine until a redeploy.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly container: ContainerClient | null = null;
  private readonly publicBaseUrl: string | undefined;
  private readonly localDir = join(process.cwd(), 'uploads');

  constructor(private readonly config: ConfigService) {
    const connectionString = this.config.get<string>('AZURE_STORAGE_CONNECTION_STRING');
    const containerName = this.config.getOrThrow<string>('AZURE_STORAGE_CONTAINER');
    this.publicBaseUrl = this.config.get<string>('AZURE_STORAGE_PUBLIC_URL');

    if (connectionString) {
      const blobService = BlobServiceClient.fromConnectionString(connectionString);
      this.container = blobService.getContainerClient(containerName);
      void this.container.createIfNotExists({ access: 'blob' });
      this.logger.log(`Azure Blob Storage ready (container: ${containerName})`);
    } else if (this.config.get('NODE_ENV') === 'production') {
      throw new Error('AZURE_STORAGE_CONNECTION_STRING is required in production');
    } else {
      this.logger.warn('No Azure connection string — uploads will be written to ./uploads');
    }
  }

  /**
   * Store a file and return its public URL.
   *
   * `prefix` namespaces the blob by tenant (e.g. `restaurants/<id>/logo`) so a
   * tenant's media is trivially enumerable and deletable when they leave.
   */
  async upload(
    buffer: Buffer,
    mimeType: string,
    prefix: string,
  ): Promise<{ url: string; key: string }> {
    const ext = ALLOWED_MIME.get(mimeType);
    if (!ext) {
      throw new BadRequestException(
        `Unsupported file type "${mimeType}". Allowed: ${[...ALLOWED_MIME.keys()].join(', ')}`,
      );
    }
    if (buffer.byteLength > MAX_BYTES) {
      throw new BadRequestException(`File exceeds the ${MAX_BYTES / 1024 / 1024}MB limit`);
    }
    if (buffer.byteLength === 0) {
      throw new BadRequestException('File is empty');
    }

    const key = `${prefix}/${randomUUID()}.${ext}`;

    if (!this.container) {
      const path = join(this.localDir, key);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, buffer);
      const apiUrl = this.config.getOrThrow<string>('API_URL');
      return { url: `${apiUrl}/uploads/${key}`, key };
    }

    const blob = this.container.getBlockBlobClient(key);
    await blob.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: mimeType,
        // Content is immutable (a fresh UUID per upload), so cache it hard.
        blobCacheControl: 'public, max-age=31536000, immutable',
      },
    });

    const url = this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : blob.url;
    return { url, key };
  }

  async delete(key: string): Promise<void> {
    if (!this.container) return;
    try {
      await this.container.getBlockBlobClient(key).deleteIfExists();
    } catch (err) {
      // A failed cleanup leaves an orphaned blob — annoying, not dangerous.
      this.logger.warn(`Failed to delete blob ${key}: ${(err as Error).message}`);
    }
  }
}
