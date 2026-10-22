import type { BankCategory, DimRange } from '@hsw-editor/bank';
import type { Locale } from '@/i18n/index.ts';
import { categoryChain } from './filters.ts';

/** Bank JSON is not re-validated in the browser, so links are only followed for plain http(s). */
export function safeExternalUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

export function formatRange(range: DimRange, locale: Locale): string {
  return `${formatNumber(range.min, locale)}–${formatNumber(range.max, locale)}`;
}

/** Localised names from the top-level category down to the element's own one. */
export function categoryPathNames(
  categories: readonly BankCategory[],
  categoryId: string,
  locale: Locale,
): string[] {
  return categoryChain(categoryId).map(
    (id) => categories.find((category) => category.id === id)?.name[locale] ?? id,
  );
}
