import { logoColorFilter } from '@/lib/name-style';

/**
 * The logo, optionally recoloured.
 *
 * `color` is one of:
 *   - ORIGINAL (or empty) — the artwork as uploaded.
 *   - WHITE / BLACK — a solid silhouette via a CSS filter (keeps the <img>, so the
 *     aspect ratio and auto-width are exactly as before).
 *   - a #rrggbb hex — a solid silhouette in that colour, done with a CSS mask (the
 *     only way to fill arbitrary colour). The mask needs a sized box, so the caller
 *     passes the same max dimensions the image would use; the mark is contained and
 *     positioned inside it, the rest of the box transparent.
 *
 * Because the uploaded logo has its background removed, the silhouette is the mark
 * itself, not a rectangle.
 */
export function LogoMark({
  url,
  name,
  color,
  maxHeight,
  maxWidth,
  align = 'center',
  className = '',
}: {
  url: string;
  name: string;
  color?: string | null;
  /** CSS length, e.g. "160px". */
  maxHeight: string;
  /** CSS length, e.g. "min(80vw, 460px)". */
  maxWidth: string;
  align?: 'left' | 'center';
  className?: string;
}) {
  const isHex = typeof color === 'string' && color.startsWith('#');

  if (!isHex) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={name}
        className={`h-auto w-auto object-contain ${className}`}
        style={{ maxHeight, maxWidth, filter: logoColorFilter(color) }}
      />
    );
  }

  const position = align === 'left' ? 'left center' : 'center';
  return (
    <span
      role="img"
      aria-label={name}
      className={`block ${className}`}
      style={{
        height: maxHeight,
        width: maxWidth,
        backgroundColor: color,
        WebkitMaskImage: `url("${url}")`,
        maskImage: `url("${url}")`,
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: position,
        maskPosition: position,
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  );
}
