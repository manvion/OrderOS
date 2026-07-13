'use client';

import { useEffect, useRef } from 'react';

/**
 * Play children in as they scroll into view.
 *
 * The IntersectionObserver only ever ADDS the class — content that has revealed
 * stays revealed. Re-hiding on scroll-out is the tell of a page that loves its own
 * animations more than its reader.
 *
 * The 12% threshold means the element is genuinely arriving, not clipping the
 * fold; `delay` staggers siblings. If JS never runs, the SERVER renders `revealed`
 * from the start via `immediate` — a storefront must never be blank because a
 * script was slow. (Pages below the fold accept the trade: hidden until hydration.)
 */
export function Reveal({
  children,
  delay = 0,
  className = '',
  as: Tag = 'div',
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  as?: 'div' | 'section' | 'li';
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.style.transitionDelay = `${delay}ms`;
          el.classList.add('revealed');
          observer.disconnect();
        }
      },
      { threshold: 0.12 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [delay]);

  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Tag ref={ref as any} className={`reveal ${className}`}>
      {children}
    </Tag>
  );
}
