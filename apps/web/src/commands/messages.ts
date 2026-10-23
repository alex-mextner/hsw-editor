import type { Command, LocalizedText } from '@hsw-editor/commands';
import { en } from '@/i18n/en.ts';
import { interpolate, type MessageParams } from '@/i18n/format.ts';
import type { Locale, MessageKey } from '@/i18n/index.ts';
import { ru } from '@/i18n/ru.ts';

/**
 * An i18n key as the engine's `{ en, ru }` text. The registry and palette hold both languages at
 * once (a query matches either), so titles cannot be resolved against the active locale here.
 */
export function msg(key: MessageKey, params?: MessageParams): LocalizedText {
  return { en: interpolate(en[key], params), ru: interpolate(ru[key], params) };
}

export function commandTitle(command: Command, locale: Locale): string {
  return command.title[locale];
}
