import { storefrontApi } from '@/lib/api';
import { OrderTracker } from '@/components/storefront/order-tracker';

/** Always fresh — a cached tracking page is worse than useless. */
export const dynamic = 'force-dynamic';

export default async function TrackPage({
  params,
}: {
  params: Promise<{ slug: string; token: string }>;
}) {
  const { slug, token } = await params;
  const order = await storefrontApi.track(slug, token);

  return <OrderTracker slug={slug} token={token} initialOrder={order} />;
}
