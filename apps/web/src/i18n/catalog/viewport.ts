import type { FeatureRu } from '../keys.ts';

/** Viewport right-click menu, copy/paste and the "add element here" flow. */
export const viewportEn = {
  'context.menu': 'Wall menu',
  'context.copy': 'Copy',
  'action.paste': 'Paste',
  'context.pasteHere': 'Paste here',
  'context.addHere': 'Add element here…',
  'context.properties': 'Variant and size…',
  'hint.placeAt': 'Pick an element in the bank to put it on the marked spot · Esc cancels',
  'floor.label': 'Floor: a tool nothing holds falls here',
} as const;

export const viewportRu: FeatureRu<typeof viewportEn> = {
  'context.menu': 'Меню стены',
  'context.copy': 'Копировать',
  'action.paste': 'Вставить',
  'context.pasteHere': 'Вставить сюда',
  'context.addHere': 'Добавить элемент сюда…',
  'context.properties': 'Вариант и размер…',
  'hint.placeAt': 'Выберите элемент в банке — он встанет на отмеченное место · Esc — отмена',
  'floor.label': 'Пол: сюда падает инструмент, который ничто не держит',
};
