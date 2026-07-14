'use client';

import { useEffect, useRef } from 'react';
import { WIDGET_MESSAGE_NAMESPACE } from '@dinedirect/shared';
import { EmbedApp } from './embed-app';

/**
 * Inline mode wrapper.
 *
 * Its whole job is height. An iframe has no intrinsic height: the browser gives
 * it whatever the parent set, and the content scrolls inside — so a menu embedded
 * in a page appears as a small box with its own scrollbar, which every user reads
 * as broken. We measure the real content height with a ResizeObserver and tell the
 * host page, which resizes the iframe to match. The result is a menu that looks
 * like part of the restaurant's page rather than a window onto ours.
 */
export function InlineEmbed({
  widgetKey,
  sessionId,
}: {
  widgetKey: string;
  sessionId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || window.parent === window) return;

    const send = () => {
      // scrollHeight, not clientHeight: we want the height of the CONTENT,
      // including anything currently overflowing, which is precisely the height
      // the iframe needs to grow to.
      const height = Math.ceil(element.scrollHeight);
      window.parent.postMessage(
        { ns: WIDGET_MESSAGE_NAMESPACE, type: 'RESIZE', height },
        '*', // The loader validates event.origin on receipt; it will ignore anything not from us.
      );
    };

    send();

    // Fires when the menu finishes loading, when an image decodes, and when the
    // customer opens a product dialog. All of those change the height.
    const observer = new ResizeObserver(send);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref}>
      <EmbedApp widgetKey={widgetKey} sessionId={sessionId} inline />
    </div>
  );
}
