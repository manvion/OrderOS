import { z } from 'zod';

/**
 * Environment contract. The app refuses to boot if this fails — a missing
 * Stripe secret should crash on startup, not at 7pm on a Friday when the first
 * customer tries to pay.
 *
 * Integrations that are legitimately optional in local dev (Twilio, Resend,
 * Uber, Azure) are optional here; their services no-op and log loudly when the
 * credentials are absent, so `docker compose up` works with nothing but a
 * Postgres and a Redis.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),

  /** Apex domain for tenant subdomains: <slug>.dinedirect.manvion.ca */
  APP_DOMAIN: z.string().default('dinedirect.manvion.ca'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  /** Comma-separated exact origins allowed in addition to *.APP_DOMAIN. */
  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // --- Clerk (required: there is no auth without it) ---
  CLERK_SECRET_KEY: z.string().min(1),
  CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().optional(),

  // --- Stripe ---
  STRIPE_SECRET_KEY: z.string().min(1),
  STRIPE_WEBHOOK_SECRET: z.string().min(1),
  /** Platform commission on each order, in basis points. 0 = free platform. */
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(3000).default(0),

  // --- Uber Direct (optional; delivery is disabled without it) ---
  UBER_CLIENT_ID: z.string().optional(),
  UBER_CLIENT_SECRET: z.string().optional(),
  UBER_CUSTOMER_ID: z.string().optional(),
  UBER_API_BASE_URL: z.string().url().default('https://api.uber.com'),
  UBER_AUTH_URL: z.string().url().default('https://auth.uber.com/oauth/v2/token'),
  /** Shared secret Uber signs delivery webhooks with (HMAC-SHA256). */
  UBER_WEBHOOK_SECRET: z.string().optional(),
  /**
   * Sandbox credentials never match a real courier -- set this true to activate
   * Uber's Robo Courier simulator on every Create Delivery call. Leave false (or
   * unset) once UBER_CUSTOMER_ID etc. are production credentials: a live account
   * has no use for a simulated courier.
   */
  UBER_SANDBOX_MODE: z.coerce.boolean().default(false),

  /**
   * --- DoorDash Drive (optional; a second courier, quoted against Uber) ---
   *
   * Auth is a self-signed JWT, not OAuth, so there is no token endpoint and nothing
   * to cache — these three credentials ARE the auth. All three or none: a partial
   * set leaves the courier unconfigured and the router simply skips it.
   *
   * DOORDASH_SIGNING_SECRET is base64url text. It is decoded before use, NOT HMAC-ed
   * as an ASCII string — doing the latter yields a well-formed token that DoorDash
   * rejects every time with an unhelpful 401.
   */
  DOORDASH_DEVELOPER_ID: z.string().optional(),
  DOORDASH_KEY_ID: z.string().optional(),
  DOORDASH_SIGNING_SECRET: z.string().optional(),
  DOORDASH_API_BASE_URL: z.string().url().default('https://openapi.doordash.com'),
  /** Defaults to DOORDASH_SIGNING_SECRET when Drive isn't given a separate one. */
  DOORDASH_WEBHOOK_SECRET: z.string().optional(),

  // --- Notifications (optional; sends become no-ops) ---
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().email().default('orders@dinedirect.manvion.ca'),

  /**
   * --- Object storage: logos, menu photos, gallery images, rendered QR PNGs ---
   *
   * Two drivers, either of which works. Pick ONE.
   *
   * S3-COMPATIBLE (Cloudflare R2, AWS S3, Backblaze, MinIO, DigitalOcean Spaces).
   * R2 is the easy answer: free to 10GB, no egress fees, two-minute signup.
   *
   * AZURE BLOB, if you already live in Azure.
   *
   * In production ONE of them is required. Without it, uploads fall back to the
   * container's local disk — which a redeploy throws away, so every restaurant's
   * logo and menu photos silently disappear and it looks like the product lost them.
   */
  S3_ENDPOINT: z.string().url().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** R2 ignores regions but the SDK insists on one. 'auto' is correct for R2. */
  S3_REGION: z.string().default('auto'),
  /**
   * The PUBLIC base URL the files are served from. NOT the API endpoint.
   *
   * These two being different is the thing that catches everyone on R2: you upload
   * to `https://<account>.r2.cloudflarestorage.com` but customers read from
   * `https://pub-<hash>.r2.dev` (or your own CDN domain). Get this wrong and every
   * image 403s while the upload itself reports success.
   */
  S3_PUBLIC_URL: z.string().url().optional(),

  AZURE_STORAGE_CONNECTION_STRING: z.string().optional(),
  AZURE_STORAGE_CONTAINER: z.string().default('dinedirect-media'),
  /** Public CDN base in front of the blob container, if any. */
  AZURE_STORAGE_PUBLIC_URL: z.string().url().optional(),

  /**
   * Where widget.js is served from. Baked into the snippet each restaurant pastes
   * into their own site, so it is effectively permanent once anyone has installed
   * it — a change here does not reach sites already carrying the old URL.
   * Unset -> ${WEB_URL}/widget.js.
   */
  WIDGET_CDN_URL: z.string().url().optional(),

  /**
   * Geocoding, which is what makes deliveryRadiusMeters real.
   *
   * Unset -> falls back to Nominatim (OpenStreetMap): free, no key, but capped at
   * ~1 req/sec by its usage policy and not licensed for heavy commercial use. Fine
   * for development and a handful of restaurants; NOT a plan for a thousand.
   *
   * Google is strongly preferred for INDIA, where informal addresses defeat most
   * other geocoders.
   */
  /**
   * Vercel, for custom domains.
   *
   * A restaurant's own domain (joesburgers.com) is attached to our ONE multi-tenant
   * Vercel project — no repo and no build per restaurant. Unset -> custom domains
   * are simply unavailable and the feature is hidden.
   */
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_PROJECT_ID: z.string().optional(),
  /** Required when the token is team-scoped, or every Vercel call 404s. */
  VERCEL_TEAM_ID: z.string().optional(),

  GOOGLE_MAPS_API_KEY: z.string().optional(),
  MAPBOX_TOKEN: z.string().optional(),

  /**
   * Courier-map ROUTING (street-following geometry). MUST be declared here — this
   * schema strips any env var it doesn't list, so an ORS_API_KEY set in the host
   * that isn't named here never reaches ConfigService, and RoutingService silently
   * falls back to the public OSRM demo, which cloud IPs get rate-limited off — the
   * map then draws a straight line "flying" over the houses. See RoutingService.
   *  - OSRM_URL / OSRM_URLS: a self-hosted OSRM (single, or per-country JSON map).
   *  - ORS_API_KEY: OpenRouteService — one free key, global coverage, the zero-infra
   *    way to get real routes everywhere.
   */
  OSRM_URL: z.string().optional(),
  OSRM_URLS: z.string().optional(),
  ORS_API_KEY: z.string().optional(),

  /**
   * MapTiler key for the courier map's basemap. Served to the browser at RUNTIME via
   * GET /storefront/map-config, so a self-host gets crisp tiles by setting this one
   * env var and restarting the API — no web rebuild. Unset, the map uses the free
   * (paler) CARTO tiles. This deliberately sidesteps NEXT_PUBLIC_MAPTILER_KEY, which
   * only applies if it was present when the web bundle was BUILT.
   */
  MAPTILER_KEY: z.string().optional(),

  /**
   * OpenRouter, for reading menus out of photographs and web pages (menu
   * import) with free vision models. Optional: unset, the dashboard hides the
   * import buttons and menus are typed by hand, exactly as before the feature
   * existed. OPENROUTER_MODELS overrides the built-in free-model ladder -- the
   * free catalog churns, so expect to update it occasionally.
   */
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODELS: z.string().optional(),

  /**
   * Comma-separated emails that become platform SUPER_ADMINs on first sign-in.
   *
   * Bootstrapping by env rather than by an endpoint is deliberate: a "create the
   * first admin" API is a permanent backdoor. An env var can only be set by someone
   * who already has production access, which is the correct bar for platform
   * ownership.
   *
   * The corollary, which is easy to miss: UNSET MEANS NOBODY IS AN ADMIN, EVER.
   * /admin rejects every visitor including you, and there is no in-app way out of
   * that. It stays `optional()` because the API must still boot for a deployment
   * that has no platform operator — but if you cannot get into /admin, this is the
   * first thing to check.
   */
  PLATFORM_ADMIN_EMAILS: z.string().optional(),

  RATE_LIMIT_TTL_SECONDS: z.coerce.number().int().default(60),
  RATE_LIMIT_MAX: z.coerce.number().int().default(120),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
