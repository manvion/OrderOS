'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';

/**
 * The gallery, "played as a video": a full-bleed crossfading slideshow with a slow
 * Ken-Burns zoom, so a restaurant with photos but no video still gets the modern,
 * moving hero. Pure CSS motion; the only JS is advancing the active slide.
 *
 * Falls back to a single static image on its own (nothing to cross-fade to).
 */
export function HeroSlideshow({ images, alt }: { images: string[]; alt: string }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (images.length < 2) return;
    const id = setInterval(() => setActive((i) => (i + 1) % images.length), 5500);
    return () => clearInterval(id);
  }, [images.length]);

  return (
    <div className="absolute inset-0 overflow-hidden bg-black">
      {images.map((src, i) => (
        <div
          key={src}
          className="absolute inset-0 transition-opacity duration-[1400ms] ease-in-out"
          style={{ opacity: i === active ? 1 : 0 }}
        >
          <Image
            src={src}
            alt={i === 0 ? alt : ''}
            fill
            priority={i === 0}
            className="kenburns object-cover"
            sizes="100vw"
          />
        </div>
      ))}
    </div>
  );
}
