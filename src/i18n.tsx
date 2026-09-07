import { createContext, useContext, useState, useEffect, useMemo } from 'react';
import translations from './locales/translations.json';

export type Locale = "en" | "es" | "fr" | "de" | "it" | "pt" | "ru" | "ja" | "zh" | "bs" | "sr" | "ko" | "ar" | "hi" | "tr" | "pl" | "nl" | "sv";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const locales = translations as Record<Locale, any>;

export const I18nContext = createContext<{
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
}>({
  locale: 'en',
  setLocale: () => {},
  t: (k) => k,
});

export function useI18n() {
  return useContext(I18nContext);
}

const warned = new Set<string>();

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');

  useEffect(() => {
    const saved = localStorage.getItem('dizako-locale') as Locale;
    if (saved && locales[saved]) {
      setLocaleState(saved);
    }
  }, []);

  const changeLocale = (l: Locale) => {
    setLocaleState(l);
    localStorage.setItem('dizako-locale', l);
  };

  /**
   * Per-key fallback chain: active locale → English → the key itself.
   *
   * Previously a locale missing one key surfaced raw dot-notation to users.
   * In dev builds a key that resolves through the fallback is reported once,
   * so coverage regressions are visible instead of silent.
   */
  const t = useMemo(() => {
    return (key: string): string => {
      const dict = locales[locale] || locales.en;
      let val = dict[key];
      if (typeof val !== 'string' && locale !== 'en') {
        val = locales.en[key];
        if (typeof val === 'string' && import.meta.env.DEV && !warned.has(key)) {
          warned.add(key);
          console.warn(`[i18n] "${locale}" missing "${key}" - falling back to English`);
        }
      }
      if (typeof val !== 'string') {
        if (import.meta.env.DEV && !warned.has(key)) {
          warned.add(key);
          console.warn(`[i18n] missing translation for "${key}"`);
        }
        return key;
      }
      return val;
    };
  }, [locale]);

  const value = useMemo(
    () => ({ locale, setLocale: changeLocale, t }),
    // changeLocale is stable enough for rendering purposes; identity churn
    // here would re-render the whole tree on every provider pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
