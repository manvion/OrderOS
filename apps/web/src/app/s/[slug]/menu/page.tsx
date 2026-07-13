import { storefrontApi } from '@/lib/api';
import { previewTokenFor } from '@/lib/preview-token';
import { MenuBrowser } from '@/components/storefront/menu-browser';

export const revalidate = 60;

export default async function MenuPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  // Fetched on the server so the menu is in the HTML: it's the page customers
  // land on from a QR code, often on bad restaurant wifi, and a client-side
  // fetch would show them a spinner while they hold their phone over a table.
  const [restaurant, menu] = await Promise.all([
    storefrontApi.getRestaurant(slug, await previewTokenFor(slug)),
    storefrontApi.getMenu(slug, await previewTokenFor(slug)),
  ]);

  return <MenuBrowser restaurant={restaurant} menu={menu} />;
}
