import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { join } from 'node:path';
import { AppModule } from './app.module';
import { WidgetService } from './modules/widget/widget.service';
import { DomainsService } from './modules/domains/domains.service';

/** Literal-escape for building a RegExp out of a CORS_ORIGINS entry. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // We install our own body parsers below, because webhooks need the raw bytes.
    bodyParser: false,
    rawBody: true,
  });

  const config = app.get<import('@nestjs/config').ConfigService>(
    (await import('@nestjs/config')).ConfigService,
  );

  /**
   * Body parsing, with a carve-out for webhooks.
   *
   * Stripe and Uber both sign the RAW request bytes. If Express parses the JSON
   * and re-serializes it, the signature will not match — key order and whitespace
   * change — and every webhook fails verification. So for those two paths we keep
   * the raw Buffer on `req.rawBody` and parse it separately.
   */
  const captureRawBody = (req: express.Request & { rawBody?: Buffer }, _res: unknown, buf: Buffer) => {
    req.rawBody = buf;
  };

  app.use('/api/payments/webhook', express.json({ verify: captureRawBody, limit: '1mb' }));
  app.use('/api/delivery/webhook', express.json({ verify: captureRawBody, limit: '1mb' }));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  app.use(
    helmet({
      // The API serves JSON and uploaded images, never HTML with inline scripts.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  /**
   * CORS. Every tenant is its own origin (`joes.dinedirect.manvion.ca`), so we can't use a
   * static allowlist — we match the apex domain's subdomains, plus any explicitly
   * configured origins (the dashboard, local dev).
   */
  const appDomain = config.getOrThrow<string>('APP_DOMAIN');
  const explicitOrigins = config
    .getOrThrow<string>('CORS_ORIGINS')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  /**
   * CORS_ORIGINS entries may carry ONE wildcard in the hostname's first label:
   * `https://dinedirect-*-myteam.vercel.app`.
   *
   * This exists for Vercel preview deployments, which mint a NEW hostname on every
   * deploy (dinedirect-<hash>-<team>.vercel.app). Without it, the dashboard works on
   * the stable domain and dies with an opaque "could not reach the API" on every
   * preview URL — which reads like an outage and cost an afternoon of debugging a
   * server that was refusing exactly as configured.
   *
   * The wildcard matches [a-z0-9-]+ only — one label's worth of deploy hash, not
   * dots — so `https://*.vercel.app` (every app Vercel hosts, including an
   * attacker's) cannot be expressed by accident. Everything else in the entry
   * matches literally.
   */
  const wildcardOrigins = explicitOrigins
    .filter((o) => o.includes('*'))
    .map(
      (o) =>
        new RegExp(
          `^${o.split('*').map(escapeRegExp).join('[a-z0-9-]+')}$`,
          'i',
        ),
    );

  const matchesExplicit = (origin: string): boolean =>
    explicitOrigins.includes(origin) || wildcardOrigins.some((re) => re.test(origin));

  // Widget traffic comes from restaurants' OWN websites — joesburgers.com,
  // some-wix-site.com — which we cannot know at boot. So the allowlist is
  // partly dynamic: anything a restaurant has registered as a widget domain is
  // allowed, and nothing else. This is the browser-enforced half of widget
  // security (WidgetTenantGuard is the other half).
  const widgetService = app.get(WidgetService);
  const domainsService = app.get(DomainsService);

  app.enableCors({
    origin: (origin, callback) => {
      // Same-origin requests and server-to-server calls send no Origin header.
      if (!origin) return callback(null, true);

      if (matchesExplicit(origin)) return callback(null, true);

      let hostname: string;
      try {
        hostname = new URL(origin).hostname;
      } catch {
        return callback(null, false);
      }

      // Our own surfaces: the apex, any tenant subdomain, local dev.
      if (
        hostname === appDomain ||
        hostname.endsWith(`.${appDomain}`) ||
        hostname.endsWith('.localhost')
      ) {
        return callback(null, true);
      }

      /**
       * Not one of our own hostnames. Two ways it can still be legitimate:
       *
       *  1. It is a restaurant's CUSTOM DOMAIN (joesburgers.com) serving their
       *     storefront. That IS our app, just on their name.
       *  2. It is a third-party site running the embedded widget, which the
       *     restaurant registered.
       *
       * Both are cached in Redis with negatives, so an unknown origin hammering
       * preflights never becomes a database hit per request.
       */
      Promise.all([
        domainsService.isKnownStorefrontOrigin(origin),
        widgetService.isOriginRegistered(origin),
      ])
        .then(([isStorefront, isWidgetHost]) => callback(null, isStorefront || isWidgetHost))
        // Fail closed. If we cannot verify the origin, we do not allow it.
        .catch(() => callback(null, false));
    },
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Restaurant-Id',
      'X-Restaurant-Slug',
      'X-Widget-Key',
      'stripe-signature',
      'x-postmates-signature',
    ],
  });

  app.setGlobalPrefix('api', {
    // Health checks answer at the root: Azure's probes don't know our prefix.
    exclude: ['health', 'health/ready'],
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );

  // Local-dev fallback for uploads when Azure Blob isn't configured.
  if (!config.get('AZURE_STORAGE_CONNECTION_STRING')) {
    app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });
  }

  if (config.get('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('DineDirect API')
      .setDescription('Direct ordering platform for restaurants')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
    logger.log('API docs at /docs');
  }

  // Behind Azure's load balancer, so req.ip must come from X-Forwarded-For —
  // otherwise every request looks like it came from the LB and rate limiting
  // throttles the whole world as one client.
  app.set('trust proxy', 1);

  app.enableShutdownHooks();

  const port = config.get<number>('PORT') ?? 4000;
  await app.listen(port, '0.0.0.0');
  logger.log(`DineDirect API listening on port ${port} (${config.get('NODE_ENV')})`);
}

void bootstrap();
