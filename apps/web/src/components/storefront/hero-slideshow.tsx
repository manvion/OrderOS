'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';

/**
 * The gallery, "played as a video": a full-bleed slideshow where each photo does a
 * fresh, grand push-in zoom while it's on screen, then cross-fades to the next. The
 * zoom restarts per slide (it's driven by the active state, not a looping CSS
 * animation) so every image gets the same cinematic move rather than being caught
 * mid-drift.
 *
 * A single image just holds still — nothing to cross-fade to.
 */

/** How long each photo is shown, ms. Short enough to feel alive, long enough to read. */
const SLIDE_MS = 4200;

export function HeroSlideshow({ images, alt }: { images: string[]; alt: string }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (images.length < 2) return;
    const id = setInterval(() => setActive((i) => (i + 1) % images.length), SLIDE_MS);
    return () => clearInterval(id);
  }, [images.length]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      {images.map((src, i) => {
        const isActive = i === active;
        return (
          <div
            key={src}
            className="absolute inset-0 transition-opacity duration-1000 ease-in-out"
            style={{ opacity: isActive ? 1 : 0 }}
          >
            {/* The zoom lives on this inner layer so it's independent of the fade.
                It runs a touch longer than the slide so the image is still moving as
                it hands off — the "never stops" feel of a video. */}
            <div
              className="absolute inset-0 will-change-transform"
              style={{
                transform: isActive ? 'scale(1.24)' : 'scale(1.06)',
                transition: `transform ${SLIDE_MS + 1200}ms ease-out`,
              }}
            >
              <Image
                src={src}
                alt={i === 0 ? alt : ''}
                fill
                priority={i === 0}
                className="object-cover"
                sizes="100vw"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
