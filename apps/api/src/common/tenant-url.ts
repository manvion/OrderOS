import type { ConfigService } from '@nestjs/config';

/**
 * The server-side answer to "what is this restaurant's public URL" — the twin of
 * apps/web/src/lib/tenant-url.ts, and every bit as load-bearing:
 *
 *   - printed QR codes point here, from paper, forever
 *   - the tracking link in every customer SMS and email points here
 *   - Stripe's checkout success_url points here — where a customer lands the
 *     moment their card is charged
 *
 * Until this existed, each of those built `https://<slug>.<APP_DOMAIN>` — a
 * subdomain of a domain this deployment may not own. On a Vercel+Railway
 * deployment that meant every QR code, every "track your order" link, and every
 * post-payment redirect resolved for NOBODY. The order flow worked right up to
 * the instant money moved, then dropped the customer on a dead hostname.
 *
 * THE RULE (one inference, no new env var): subdomain tenancy exists only when
 * WEB_URL itself lives under APP_DOMAIN. If the operator's web app runs at
 * https://dashboard.dinedirect.ca and APP_DOMAIN=dinedirect.ca, then joes.dinedirect.ca
 * is real — use it. If WEB_URL is a vercel.app host or localhost, no wildcard
 * subdomain can exist — use `${WEB_URL}/s/<slug>`, which the middleware serves
 * everywhere except on a real apex.
 */
export function storefrontBaseUrl(config: ConfigService, slug: string): string {
  const webUrl = config.getOrThrow<string>('WEB_URL').replace(/\/$/, '');
  const appDomain = config.getOrThrow<string>('APP_DOMAIN');

  let webHost: string;
  try {
    webHost = new URL(webUrl).hostname;
  } catch {
    return `${webUrl}/s/${slug}`;
  }

  const subdomainsExist = webHost === appDomain || webHost.endsWith(`.${appDomain}`);

  return subdomainsExist ? `https://${slug}.${appDomain}` : `${webUrl}/s/${slug}`;
}
