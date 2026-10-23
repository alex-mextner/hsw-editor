/** UI strings of the invalid-zone feature (ru/en). Placeholders use `{name}`. */
import type { InvalidMessageKey } from './reasons.ts';

export const invalidZonesEn = {
  'invalid.toggle': 'Invalid zones',
  'invalid.toggleHint': 'Highlight overlapping and protruding parts with red stripes',
  'invalid.legend.title': 'Invalid zones',
  'invalid.legend.none': 'No invalid zones',
  'invalid.legend.count.one': '{count} item has invalid parts',
  'invalid.legend.count.other': '{count} items have invalid parts',
  'invalid.legend.swatch': 'Red diagonal stripes mark the invalid part',
  'invalid.inspector.title': 'Invalid parts',
  'invalid.overlap': 'Overlaps {other} by {depth} mm',
  'invalid.out.left': 'Protrudes {extent} mm past the left board edge',
  'invalid.out.right': 'Protrudes {extent} mm past the right board edge',
  'invalid.out.bottom': 'Protrudes {extent} mm past the bottom board edge',
  'invalid.out.top': 'Protrudes {extent} mm past the top board edge',
  'invalid.out.behindWall': 'Sinks {extent} mm behind the wall plane',
} as const satisfies Readonly<Record<InvalidMessageKey, string>> & Readonly<Record<string, string>>;

export const invalidZonesRu = {
  'invalid.toggle': 'Недопустимые зоны',
  'invalid.toggleHint': 'Подсвечивать пересекающиеся и выступающие части красными полосами',
  'invalid.legend.title': 'Недопустимые зоны',
  'invalid.legend.none': 'Недопустимых зон нет',
  'invalid.legend.count.one': 'У {count} элемента есть недопустимые части',
  'invalid.legend.count.other': 'У {count} элементов есть недопустимые части',
  'invalid.legend.count.few': 'У {count} элементов есть недопустимые части',
  'invalid.legend.count.many': 'У {count} элементов есть недопустимые части',
  'invalid.legend.swatch': 'Красные диагональные полосы отмечают недопустимую часть',
  'invalid.inspector.title': 'Недопустимые части',
  'invalid.overlap': 'Пересекается с {other} на {depth} мм',
  'invalid.out.left': 'Выступает на {extent} мм за левый край доски',
  'invalid.out.right': 'Выступает на {extent} мм за правый край доски',
  'invalid.out.bottom': 'Выступает на {extent} мм за нижний край доски',
  'invalid.out.top': 'Выступает на {extent} мм за верхний край доски',
  'invalid.out.behindWall': 'Заходит на {extent} мм за плоскость стены',
} as const satisfies Record<
  keyof typeof invalidZonesEn | `invalid.legend.count.${'few' | 'many'}`,
  string
>;
