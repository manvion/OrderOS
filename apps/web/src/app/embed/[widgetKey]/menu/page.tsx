import { InlineEmbed } from '@/components/widget/inline-embed';

/**
 * Inline mode: the menu rendered in the page flow, wherever the restaurant put
 * <div id="orderos-menu">.
 *
 * Separate route from the modal embed because it has to measure and broadcast its
 * own height (an iframe has no intrinsic height — without a RESIZE message the
 * host page shows a 600px box with a scrollbar inside a scrollbar, which is the
 * classic broken-embed look).
 */
export default async function InlineMenuPage({
  params,
  searchParams,
}: {
  params: Promise<{ widgetKey: string }>;
  searchParams: Promise<{ sid?: string }>;
}) {
  const { widgetKey } = await params;
  const { sid } = await searchParams;

  return <InlineEmbed widgetKey={widgetKey} sessionId={sid ?? 'sid_unknown'} />;
}
