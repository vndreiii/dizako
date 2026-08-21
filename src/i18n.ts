import { createContext, useContext, useState, useEffect } from 'react';
import translations from './locales/translations.json';

export type Locale = 'en' | 'es' | 'fr';

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

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>('en');

  useEffect(() => {
    const saved = localStorage.getItem('dizako-locale') as Locale;
    if (saved && locales[saved]) {
      setLocale(saved);
    }
  }, []);

  const changeLocale = (l: Locale) => {
    setLocale(l);
    localStorage.setItem('dizako-locale', l);
  };

  const t = (key: string): string => {
    const dict = locales[locale] || locales.en;
    const val = dict[key];
    return typeof val === 'string' ? val : key;
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale: changeLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}
