import { useCallback } from 'react';
import { useStore } from '@/state/react.ts';
import { en } from './en.ts';
import { interpolate, type MessageParams } from './format.ts';
import { localeStore, type Locale } from './locale.ts';
import type { Catalogue, MessageKey, PluralKey } from './keys.ts';
import { ru } from './ru.ts';

export { LOCALES, localeStore, type Locale } from './locale.ts';
export type { MessageKey, PluralKey } from './keys.ts';

const catalogues: Readonly<Record<Locale, Catalogue>> = { ru, en };
const lookups: Readonly<Record<Locale, ReadonlyMap<string, string>>> = {
  ru: new Map(Object.entries(ru)),
  en: new Map(Object.entries(en)),
};

export type Translate = (key: MessageKey, params?: MessageParams) => string;
export type TranslatePlural = (key: PluralKey, count: number, params?: MessageParams) => string;

const PLURAL_RULES: Readonly<Record<Locale, Intl.PluralRules>> = {
  ru: new Intl.PluralRules('ru'),
  en: new Intl.PluralRules('en'),
};

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  return interpolate(catalogues[locale][key], params);
}

function translatePlural(
  locale: Locale,
  key: PluralKey,
  count: number,
  params?: MessageParams,
): string {
  const category = PLURAL_RULES[locale].select(count);
  const lookup = lookups[locale];
  const template =
    lookup.get(`${key}.${category}`) ?? catalogues[locale][`${key}.other` as MessageKey];
  return interpolate(template, { count, ...params });
}

/** Translate outside React (toasts, command labels built at call time). */
export const t: Translate = (key, params) => translate(localeStore.get(), key, params);

/** Plural-aware `t` for the same callers. */
export const tn: TranslatePlural = (key, count, params) =>
  translatePlural(localeStore.get(), key, count, params);

export function useI18n(): {
  readonly locale: Locale;
  readonly t: Translate;
  readonly tn: TranslatePlural;
} {
  const locale = useStore(localeStore);
  const tx = useCallback<Translate>((key, params) => translate(locale, key, params), [locale]);
  const tn = useCallback<TranslatePlural>(
    (key, count, params) => translatePlural(locale, key, count, params),
    [locale],
  );
  return { locale, t: tx, tn };
}

export function useT(): Translate {
  return useI18n().t;
}
