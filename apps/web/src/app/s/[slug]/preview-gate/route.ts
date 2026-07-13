import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * The door into an unpublished storefront.
 *
 * The dashboard's "Preview" button links here with a staff-minted token. We move
 * the token from the URL into a cookie and bounce to the homepage, so the WHOLE
 * site works during the preview — menu, about, every internal link — instead of
 * one magic URL that breaks on the first click. It also keeps the token out of
 * the address bar the owner is about to screenshot and send to their partner.
 *
 * The cookie is just a courier. Every page hands it to the API, and the API
 * decides whether it is (still) valid — an expired preview degrades to the same
 * 404 the public sees, never to an error page.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const token = req.nextUrl.searchParams.get('token') ?? '';

  // On a tenant subdomain the middleware rewrote /preview-gate to /s/<slug>/…,
  // and the browser's real path has no /s prefix. The header the middleware sets
  // on that rewrite is the reliable signal for which world we're in.
  const onSubdomain = Boolean(req.headers.get('x-restaurant-slug'));
  const home = new URL(onSubdomain ? '/' : `/s/${slug}`, req.url);

  const jar = await cookies();
  jar.set('sf-preview', `${slug}:${token}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.nextUrl.protocol === 'https:',
    maxAge: 30 * 60,
    path: '/',
  });

  return NextResponse.redirect(home);
}
