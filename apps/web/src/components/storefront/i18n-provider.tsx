'use client';

import { createContext, useContext, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getDictionary,
  LOCALE_COOKIE,
  type Dictionary,
  type Locale,
} from '@/lib/i18n/dictionaries';

interface I18nValue {
  locale: Locale;
  /** The translated strings for the current locale. */
  t: Dictionary;
  /** Only true when the restaurant is set to BOTH languages — otherwise there's
   *  nothing to switch and the toggle is hidden. */
  canToggle: boolean;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18nValue | null>(null);

/** The translated dictionary for the current locale. */
export function useT(): Dictionary {
  const ctx = useContext(I18nContext);
  // Fall back to English if used outside the provider — a missing translation must
  // never blank the page.
  return ctx?.t ?? getDictionary('en');
}

/** Current locale + the switcher, for the language toggle. */
export function useLocale(): { locale: Locale; canToggle: boolean; setLocale: (l: Locale) => void } {
  const ctx = useContext(I18nContext);
  return {
    locale: ctx?.locale ?? 'en',
    canToggle: ctx?.canToggle ?? false,
    setLocale: ctx?.setLocale ?? (() => {}),
  };
}

export function I18nProvider({
  initialLocale,
  canToggle,
  children,
}: {
  initialLocale: Locale;
  canToggle: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = (next: Locale) => {
    setLocaleState(next);
    // A year-long cookie, readable by the server layout on the next render so the
    // server-rendered header/footer switch language too. `refresh()` re-runs the
    // server components with the new cookie without a full reload.
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  };

  return (
    <I18nContext.Provider value={{ locale, t: getDictionary(locale), canToggle, setLocale }}>
      {children}
    </I18nContext.Provider>
  );
}
