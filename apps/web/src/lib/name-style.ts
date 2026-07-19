import type { CSSProperties } from 'react';

/**
 * Turn a restaurant's saved name-wordmark settings (nameFont / nameColor /
 * nameTransform) into inline CSS.
 *
 * The values are stored as plain strings so a new face can be added without a DB
 * migration; anything we don't recognise falls back to the default, so an old or
 * unexpected value can never render as broken text.
 */

/** System / already-loaded faces only — never fetches a web font, so the wordmark
 *  can't cause a layout shift or a blocked paint on the storefront. */
const FONT_STACKS: Record<string, string> = {
  DISPLAY: 'var(--font-display), ui-serif, Georgia, serif',
  SANS: 'var(--font-sans), ui-sans-serif, system-ui, sans-serif',
  SERIF: 'Georgia, Cambria, "Times New Roman", Times, serif',
  MONO: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, "Courier New", monospace',
  SCRIPT: '"Brush Script MT", "Segoe Script", "Bradley Hand", cursive',
};

type NameStyleInput = {
  nameFont?: string | null;
  nameColor?: string | null;
  nameTransform?: string | null;
};

export function nameWordmarkStyle(restaurant: NameStyleInput): CSSProperties {
  const style: CSSProperties = {
    fontFamily: FONT_STACKS[restaurant.nameFont ?? 'DISPLAY'] ?? FONT_STACKS.DISPLAY,
  };

  if (restaurant.nameColor === 'BRAND') style.color = 'var(--brand)';
  else if (restaurant.nameColor) style.color = restaurant.nameColor;

  if (restaurant.nameTransform === 'UPPERCASE') {
    style.textTransform = 'uppercase';
    style.letterSpacing = '0.08em';
  }

  return style;
}
