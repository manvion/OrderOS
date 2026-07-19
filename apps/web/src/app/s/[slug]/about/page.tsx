import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * The About page has been folded into the homepage — the story, hours and contact
 * now render there (see components/storefront/story-band.tsx), so a restaurant's
 * site is one page, not two.
 *
 * This route stays only to redirect: old links, bookmarks and printed QR codes that
 * point at /about must land somewhere real, not a 404. It sends them to the homepage
 * where that same content now lives.
 */
export default async function AboutRedirect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // On a real subdomain the storefront is the site root; under /s/<slug> it isn't.
  const base = (await headers()).get('x-restaurant-slug') ? '' : `/s/${slug}`;
  redirect(base || '/');
}
