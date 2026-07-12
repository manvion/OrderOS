import { EmbedApp } from '@/components/widget/embed-app';

/**
 * The ordering experience, as rendered inside the widget's iframe on a
 * restaurant's own website.
 *
 * Everything is client-side: the iframe is loaded once and the customer moves
 * between menu → cart → checkout → tracking without a navigation, because a full
 * page load inside an iframe flashes white and looks broken on a slow phone.
 */
export default async function EmbedPage({
  params,
  searchParams,
}: {
  params: Promise<{ widgetKey: string }>;
  searchParams: Promise<{ sid?: string; view?: string }>;
}) {
  const { widgetKey } = await params;
  const { sid, view } = await searchParams;

  return (
    <EmbedApp
      widgetKey={widgetKey}
      sessionId={sid ?? 'sid_unknown'}
      initialView={view === 'menu' ? 'menu' : 'menu'}
      inline={false}
    />
  );
}
