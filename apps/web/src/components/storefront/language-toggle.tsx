'use client';

import { useLocale } from './i18n-provider';

/**
 * EN / FR switch. Renders only when the restaurant is set to BOTH languages
 * (`canToggle`) — a single-language storefront has nothing to switch.
 */
export function LanguageToggle() {
  const { locale, canToggle, setLocale } = useLocale();
  if (!canToggle) return null;

  return (
    <div
      className="inline-flex overflow-hidden rounded-full border text-xs font-semibold"
      role="group"
      aria-label="Language"
    >
      {(['en', 'fr'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLocale(l)}
          aria-pressed={locale === l}
          className={`px-2.5 py-1 uppercase transition-colors ${
            locale === l ? 'bg-brand text-brand-foreground' : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
