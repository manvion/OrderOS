'use client';

import { useCallback, useState } from 'react';
import {
  getDictionary,
  LOCALE_COOKIE,
  toLocale,
  type Dictionary,
  type Locale,
} from './dictionaries';

/**
 * Locale for DASHBOARD/staff screens (the kitchen board and, later, the rest of the
 * dashboard), following the same rule as the storefront: the restaurant's content
 * language pins it, and BOTH lets staff switch (persisted in a cookie).
 *
 * Unlike the storefront's I18nProvider, this is a plain hook with no server render to
 * coordinate — dashboard screens are fully client-side — so it just carries client
 * state and writes the cookie, no `router.refresh()` needed.
 */
function readCookieLocale(): Locale {
  if (typeof document === 'undefined') return 'en';
  const match = document.cookie.match(new RegExp(`(?:^|; )${LOCALE_COOKIE}=([^;]+)`));
  return toLocale(match?.[1]);
}

export function useContentLocale(menuLanguage: 'EN' | 'FR' | 'BOTH' | undefined): {
  locale: Locale;
  canToggle: boolean;
  setLocale: (l: Locale) => void;
  t: Dictionary;
} {
  const canToggle = menuLanguage === 'BOTH';
  // A single-language restaurant pins the locale; BOTH reads the saved choice.
  const pinned: Locale | null =
    menuLanguage === 'FR' ? 'fr' : menuLanguage === 'EN' ? 'en' : null;

  const [chosen, setChosen] = useState<Locale>(() => (canToggle ? readCookieLocale() : 'en'));
  const locale = pinned ?? chosen;

  const setLocale = useCallback((next: Locale) => {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setChosen(next);
  }, []);

  return { locale, canToggle, setLocale, t: getDictionary(locale) };
}
