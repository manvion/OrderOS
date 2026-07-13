import { cookies } from 'next/headers';

/**
 * The preview token for THIS restaurant, if the visitor is carrying one.
 *
 * Set by /preview-gate, scoped to a single slug so a preview of one restaurant
 * can never unlock another. Returning undefined is the common case — this runs
 * on every public storefront render, so the miss path is one cookie read.
 *
 * Server components only (next/headers).
 */
export async function previewTokenFor(slug: string): Promise<string | undefined> {
  const raw = (await cookies()).get('sf-preview')?.value;
  if (!raw) return undefined;

  const separator = raw.indexOf(':');
  if (separator === -1) return undefined;

  return raw.slice(0, separator) === slug ? raw.slice(separator + 1) : undefined;
}
