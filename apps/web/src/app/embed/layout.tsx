import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Order online',
  // This page only ever exists inside someone else's website. It must never be
  // indexed as a standalone result competing with the restaurant's own site.
  robots: { index: false, follow: false },
};

/**
 * The embed shell. A passthrough — the root layout already provides <html>/<body>,
 * and Next permits exactly one root layout per tree.
 *
 * The embed's own chrome (header, close button, brand colour) lives in EmbedApp
 * rather than here, because it has to react to settings fetched at runtime.
 */
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
