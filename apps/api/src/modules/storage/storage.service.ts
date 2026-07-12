import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

/** Immutable content — a fresh UUID per upload — so it can be cached forever. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

type Driver = 's3' | 'azure' | 'local';

/**
 * Object storage for logos, menu photos, gallery images and rendered QR PNGs.
 *
 * THREE drivers, one interface:
 *
 *   s3    — anything S3-compatible: Cloudflare R2, AWS S3, Backblaze B2, MinIO,
 *           DigitalOcean Spaces. R2 is the easy answer for a new deployment: free
 *           to 10GB, no egress fees, two-minute signup.
 *   azure — Azure Blob, if you already live there.
 *   local — ./uploads on disk. Dev only.
 *
 * The local driver is REFUSED in production, loudly, at boot. A container's disk is
 * thrown away on every redeploy, so writing customers' logos to it doesn't fail —
 * it works perfectly, right up until the deploy that silently erases every image
 * every restaurant has ever uploaded. That is a data-loss bug that looks like a
 * deployment succeeding, which is the worst kind, so it crashes at startup instead.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly driver: Driver;

  private readonly s3: S3Client | null = null;
  private readonly bucket: string | undefined;
  private readonly container: ContainerClient | null = null;
  private readonly publicBaseUrl: string | undefined;
  private readonly localDir = join(process.cwd(), 'uploads');

  constructor(private readonly config: ConfigService) {
    const s3Bucket = this.config.get<string>('S3_BUCKET');
    const s3Endpoint = this.config.get<string>('S3_ENDPOINT');
    const s3Key = this.config.get<string>('S3_ACCESS_KEY_ID');
    const s3Secret = this.config.get<string>('S3_SECRET_ACCESS_KEY');

    const azureConnection = this.config.get<string>('AZURE_STORAGE_CONNECTION_STRING');

    if (s3Bucket && s3Endpoint && s3Key && s3Secret) {
      this.driver = 's3';
      this.bucket = s3Bucket;
      this.s3 = new S3Client({
        region: this.config.get<string>('S3_REGION') ?? 'auto',
        endpoint: s3Endpoint,
        credentials: { accessKeyId: s3Key, secretAccessKey: s3Secret },
        // R2, MinIO and most non-AWS S3 implementations need path-style addressing.
        // Virtual-host style ("bucket.endpoint") resolves to nothing on them, and
        // the failure looks like a DNS error rather than a config one.
        forcePathStyle: true,
      });

      /**
       * The public URL is NOT the endpoint we upload to. On R2 you write to
       * `<account>.r2.cloudflarestorage.com` and the world reads from
       * `pub-<hash>.r2.dev` or your own CDN domain. Conflating them is the single
       * most common R2 mistake: uploads report success and every image 403s.
       */
      this.publicBaseUrl = this.config.get<string>('S3_PUBLIC_URL');
      if (!this.publicBaseUrl) {
        throw new Error(
          'S3_PUBLIC_URL is required: it is the public base URL images are SERVED from ' +
            '(e.g. https://pub-xxxx.r2.dev), which is not the same as S3_ENDPOINT, the URL ' +
            'they are uploaded to. Without it every uploaded image would 403.',
        );
      }

      this.logger.log(`Object storage: S3-compatible (bucket: ${s3Bucket})`);
      return;
    }

    if (azureConnection) {
      this.driver = 'azure';
      const containerName = this.config.getOrThrow<string>('AZURE_STORAGE_CONTAINER');
      this.publicBaseUrl = this.config.get<string>('AZURE_STORAGE_PUBLIC_URL');

      const blobService = BlobServiceClient.fromConnectionString(azureConnection);
      this.container = blobService.getContainerClient(containerName);
      void this.container.createIfNotExists({ access: 'blob' });

      this.logger.log(`Object storage: Azure Blob (container: ${containerName})`);
      return;
    }

    if (this.config.get('NODE_ENV') === 'production') {
      throw new Error(
        'No object storage configured. Set either S3_BUCKET/S3_ENDPOINT/S3_ACCESS_KEY_ID/' +
          'S3_SECRET_ACCESS_KEY/S3_PUBLIC_URL (Cloudflare R2, AWS S3, Backblaze…) or ' +
          'AZURE_STORAGE_CONNECTION_STRING.\n' +
          'Refusing to start: without one, uploads go to the container disk and every ' +
          'restaurant loses every image on the next redeploy.',
      );
    }

    this.driver = 'local';
    this.logger.warn('No object storage configured — uploads will be written to ./uploads');
  }

  /**
   * Store a file and return its public URL.
   *
   * `prefix` namespaces the object by tenant (e.g. `restaurants/<id>/logo`) so one
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

    if (this.driver === 's3') {
      await this.s3!.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          // Set explicitly. Without it S3 serves application/octet-stream and the
          // browser downloads the logo instead of rendering it.
          ContentType: mimeType,
          CacheControl: CACHE_CONTROL,
        }),
      );

      return { url: `${this.publicBaseUrl}/${key}`, key };
    }

    if (this.driver === 'azure') {
      const blob = this.container!.getBlockBlobClient(key);
      await blob.uploadData(buffer, {
        blobHTTPHeaders: { blobContentType: mimeType, blobCacheControl: CACHE_CONTROL },
      });

      return { url: this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : blob.url, key };
    }

    const path = join(this.localDir, key);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, buffer);

    const apiUrl = this.config.getOrThrow<string>('API_URL');
    return { url: `${apiUrl}/uploads/${key}`, key };
  }

  async delete(key: string): Promise<void> {
    try {
      if (this.driver === 's3') {
        await this.s3!.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        return;
      }
      if (this.driver === 'azure') {
        await this.container!.getBlockBlobClient(key).deleteIfExists();
      }
      // Local: leave it. A dev's ./uploads folder is not a billing problem.
    } catch (err) {
      // A failed cleanup leaves an orphaned object — a slow bill, not a broken app.
      // Never let it fail the request that triggered it.
      this.logger.warn(`Failed to delete object ${key}: ${(err as Error).message}`);
    }
  }
}
