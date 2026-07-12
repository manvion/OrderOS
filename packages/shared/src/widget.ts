import { z } from 'zod';

/**
 * Embeddable widget: settings, validation, and the postMessage protocol.
 *
 * Shared because three separate things must agree on these shapes — the API that
 * stores them, the dashboard form that edits them, and the widget loader that
 * renders from them.
 */

export const WIDGET_KEY_PREFIX = 'wk_';

export const widgetModeSchema = z.enum([
  /** A floating button in a page corner. The default; works on any site. */
  'FLOATING_BUTTON',
  /** The menu rendered inline wherever the container div is placed. */
  'INLINE_MENU',
  /** No UI of our own — the site's own button calls window.OrderOS.open(). */
  'MANUAL_TRIGGER',
]);
export type WidgetMode = z.infer<typeof widgetModeSchema>;

export const widgetPositionSchema = z.enum([
  'BOTTOM_RIGHT',
  'BOTTOM_LEFT',
  'TOP_RIGHT',
  'TOP_LEFT',
]);
export type WidgetPosition = z.infer<typeof widgetPositionSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex colour like #EA580C');

export const widgetSettingsSchema = z.object({
  mode: widgetModeSchema.default('FLOATING_BUTTON'),
  position: widgetPositionSchema.default('BOTTOM_RIGHT'),

  buttonText: z.string().min(1).max(30).default('Order Now'),
  primaryColor: hexColor.default('#EA580C'),
  textColor: hexColor.default('#FFFFFF'),

  /**
   * A font *stack*, not a URL. The widget never loads a webfont: pulling a font
   * into someone else's page is a third-party request they didn't ask for and a
   * layout shift they'll blame on us. Naming a family the host site already
   * loads costs nothing and inherits their typography.
   *
   * The charset is restricted because this value is interpolated directly into a
   * CSS rule in the loader. Without the restriction, `Arial; } body { display:none } .x {`
   * is a stored CSS injection into the restaurant's own homepage — self-inflicted,
   * but a compromised or careless dashboard account should not be able to deface
   * the live website. Letters, digits, spaces, quotes, commas and hyphens are all
   * a legitimate font stack ever needs; braces, semicolons and parens are not.
   */
  fontFamily: z
    .string()
    .max(200)
    .regex(
      /^[a-zA-Z0-9\s,'"-]+$/,
      'A font stack may only contain letters, numbers, spaces, quotes, commas and hyphens',
    )
    .default('system-ui, -apple-system, "Segoe UI", sans-serif'),

  borderRadius: z.number().int().min(0).max(32).default(12),

  /** Show the restaurant's logo in the widget header. */
  showLogo: z.boolean().default(true),

  /**
   * Open full-screen instead of as a modal. Always true on narrow screens
   * regardless of this — a 380px modal on a phone is unusable.
   */
  fullPage: z.boolean().default(false),

  /** Hide the button outside business hours rather than letting people start an order they can't finish. */
  hideWhenClosed: z.boolean().default(false),
});

export type WidgetSettings = z.infer<typeof widgetSettingsSchema>;

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = widgetSettingsSchema.parse({});

/**
 * Normalise anything an owner might paste ("https://Joes.com/order?x=1", "www.joes.com")
 * into the bare, lowercase host we compare Origin headers against.
 *
 * Returns null for input we can't make sense of — the caller turns that into a
 * validation error rather than storing a domain that will never match.
 */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  let host = trimmed;

  // Tolerate a full URL.
  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      return null;
    }
  } else {
    // Strip any path, query or port the owner pasted along with the host.
    host = host.split('/')[0].split('?')[0].split(':')[0];
  }

  // `www.joes.com` and `joes.com` are the same site to a human, and a customer
  // may land on either. Store the bare host and match both at check time.
  if (host.startsWith('www.')) host = host.slice(4);

  // A hostname, not a sentence. Rejects spaces, protocols we missed, and junk.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    // localhost is the one legitimate dotless host — restaurants and their
    // developers test the widget locally before it goes on the real site.
    if (host !== 'localhost') return null;
  }

  return host;
}

/**
 * Does `origin` (an Origin header, e.g. "https://www.joes.com") match a domain on
 * the allowlist?
 *
 * Matches the bare host and its `www.` form. Does NOT match arbitrary
 * subdomains: `evil.joes.com` is not authorised by `joes.com`, because on shared
 * hosts (wordpress.com, squarespace.com) a subdomain belongs to someone else
 * entirely. A restaurant that needs `order.joes.com` adds it explicitly.
 */
export function isOriginAllowed(origin: string, allowedDomains: string[]): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }

  const bare = host.startsWith('www.') ? host.slice(4) : host;
  return allowedDomains.some((domain) => domain === bare);
}

export const createIntegrationSchema = z.object({
  name: z.string().min(1).max(80),
  domain: z.string().min(3).max(253),
  settings: widgetSettingsSchema.partial().optional(),
});
export type CreateIntegrationInput = z.infer<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  /** The full allowlist, replaced wholesale. Empty is rejected — it would brick the widget. */
  allowedDomains: z.array(z.string().min(3).max(253)).min(1).max(10).optional(),
  settings: widgetSettingsSchema.partial().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateIntegrationInput = z.infer<typeof updateIntegrationSchema>;

export const widgetEventSchema = z.object({
  type: z.enum(['VIEW', 'OPEN', 'ADD_TO_CART', 'CHECKOUT_START']),
  sessionId: z.string().min(8).max(64),
});
export type WidgetEventInput = z.infer<typeof widgetEventSchema>;

/**
 * The postMessage contract between the loader (host page) and the iframe.
 *
 * Both sides check `event.origin` before acting on a message — the host page may
 * contain other iframes, and any of them can postMessage to the parent.
 */
export const WIDGET_MESSAGE_NAMESPACE = 'orderos';

export type WidgetToHostMessage =
  | { ns: 'orderos'; type: 'READY' }
  | { ns: 'orderos'; type: 'CLOSE' }
  /** Inline mode: the iframe has no intrinsic height, so it tells us its content height. */
  | { ns: 'orderos'; type: 'RESIZE'; height: number }
  /** Stripe refuses to be framed — the host page must open Checkout in a new tab. */
  | { ns: 'orderos'; type: 'OPEN_CHECKOUT'; url: string }
  | { ns: 'orderos'; type: 'CART_COUNT'; count: number };

export type HostToWidgetMessage =
  | { ns: 'orderos'; type: 'INIT'; origin: string; pageUrl: string; sessionId: string }
  | { ns: 'orderos'; type: 'OPEN' };
