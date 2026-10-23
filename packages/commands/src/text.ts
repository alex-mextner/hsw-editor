/**
 * Localised strings for the registry and the palette. The UI language is `ru` or `en`; the package
 * stays free of any i18n framework so the same data feeds the palette, the keybinding editor and
 * the AI tool listing.
 */
export type Locale = 'en' | 'ru';

export const LOCALES: readonly Locale[] = ['en', 'ru'];

export interface LocalizedText {
  readonly en: string;
  readonly ru: string;
}

/** A label is either a fixed string (a wall name, a tool name) or a localised one. */
export type Label = string | LocalizedText;

export function labelText(label: Label, locale: Locale): string {
  return typeof label === 'string' ? label : label[locale];
}

/** Every language variant of a label, used to match a query against all of them. */
export function labelVariants(label: Label): readonly string[] {
  return typeof label === 'string' ? [label] : [label.en, label.ru];
}
