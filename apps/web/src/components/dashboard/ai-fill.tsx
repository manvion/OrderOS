'use client';

import { Sparkles } from 'lucide-react';

export type ContentLanguage = 'EN' | 'FR' | 'BOTH';

/**
 * The "AI fill" control, shaped by the restaurant's content-language setting.
 *
 * A single-language restaurant gets one button that writes in that language — no
 * choice to make. A bilingual (BOTH) restaurant gets English / French / Both, so a
 * menu that serves both can be written either way. The language the buttons pass is
 * what the generator uses, everywhere it appears (menu items, catering packages).
 */
export function AiFill({
  language,
  pending,
  activeVariant,
  onFill,
  disabled,
}: {
  language: ContentLanguage;
  pending: boolean;
  activeVariant?: ContentLanguage;
  onFill: (lang: ContentLanguage) => void;
  disabled?: boolean;
}) {
  const options: Array<[ContentLanguage, string]> =
    language === 'BOTH'
      ? [
          ['EN', 'English'],
          ['FR', 'French'],
          ['BOTH', 'Both'],
        ]
      : [[language, 'AI fill']];

  return (
    <div className="flex items-center gap-2 text-xs">
      {language === 'BOTH' && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Sparkles className="h-3 w-3" />
          AI fill
        </span>
      )}
      {options.map(([code, label]) => (
        <button
          key={code}
          type="button"
          onClick={() => onFill(code)}
          disabled={pending || disabled}
          className="flex items-center gap-1 font-medium text-brand hover:underline disabled:opacity-50"
        >
          {language !== 'BOTH' && <Sparkles className="h-3 w-3" />}
          {pending && activeVariant === code ? 'Writing…' : label}
        </button>
      ))}
    </div>
  );
}
