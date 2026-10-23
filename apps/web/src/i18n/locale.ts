import { createValueStore } from '#state-backend';

export const LOCALES = ['ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ru';
const STORAGE_KEY = 'hsw-editor.locale';

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'ru' || value === 'en';
}

/** Browser language -> supported locale; unsupported languages fall back to the product default (ru). */
export function localeFromLanguage(language: string | undefined): Locale {
  const primary = language?.toLowerCase().split('-')[0];
  return isLocale(primary) ? primary : DEFAULT_LOCALE;
}

function initialLocale(): Locale {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // Storage unavailable: fall through to the browser language.
  }
  return localeFromLanguage(globalThis.navigator?.language);
}

export const localeStore = createValueStore<Locale>(initialLocale());

localeStore.subscribe(() => {
  const locale = localeStore.get();
  if (globalThis.document) globalThis.document.documentElement.lang = locale;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // The in-memory store still works.
  }
});
if (globalThis.document) globalThis.document.documentElement.lang = localeStore.get();
