import { ConfigService } from '@nestjs/config';
import { StorageService } from './storage.service';

/**
 * These tests are about ONE failure mode, and it is a data-loss one.
 *
 * Without object storage configured, uploads go to the container's local disk. That
 * does not error. It works perfectly — right up until the next redeploy throws the
 * disk away, at which point every logo and every menu photo every restaurant has ever
 * uploaded is gone, with no error anywhere and no way to get them back.
 *
 * A deployment that succeeds and destroys data is the worst kind of bug, so the
 * service refuses to start instead. These tests hold that line.
 */
function configWith(values: Record<string, string | undefined>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(`Missing ${key}`);
      return v;
    },
  } as unknown as ConfigService;
}

const R2 = {
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'dinedirect-media',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_REGION: 'auto',
  S3_PUBLIC_URL: 'https://pub-abc.r2.dev',
};

describe('StorageService driver selection', () => {
  it('REFUSES to boot in production with no storage configured', () => {
    expect(() => new StorageService(configWith({ NODE_ENV: 'production' }))).toThrow(
      /No object storage configured/,
    );
  });

  it('falls back to local disk in development, loudly', () => {
    // Dev has no S3 account and shouldn't need one. Losing ./uploads costs nothing.
    expect(() => new StorageService(configWith({ NODE_ENV: 'development' }))).not.toThrow();
  });

  it('accepts a complete S3/R2 configuration in production', () => {
    expect(() => new StorageService(configWith({ NODE_ENV: 'production', ...R2 }))).not.toThrow();
  });

  /**
   * The classic R2 mistake, caught at boot rather than in production.
   *
   * S3_ENDPOINT is where we UPLOAD (acct.r2.cloudflarestorage.com). S3_PUBLIC_URL is
   * where the world READS (pub-xxx.r2.dev). They are different URLs. Omit the second
   * and every upload reports success while every image 403s — a failure that looks
   * like the images are broken rather than the config.
   */
  it('refuses an S3 config missing S3_PUBLIC_URL, naming the mistake', () => {
    const { S3_PUBLIC_URL, ...withoutPublicUrl } = R2;

    expect(
      () => new StorageService(configWith({ NODE_ENV: 'production', ...withoutPublicUrl })),
    ).toThrow(/S3_PUBLIC_URL is required/);
  });

  it('takes Azure when S3 is absent', () => {
    expect(
      () =>
        new StorageService(
          configWith({
            NODE_ENV: 'production',
            AZURE_STORAGE_CONNECTION_STRING:
              'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=aaaa;EndpointSuffix=core.windows.net',
            AZURE_STORAGE_CONTAINER: 'dinedirect-media',
          }),
        ),
    ).not.toThrow();
  });
});
