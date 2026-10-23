import { describe, expect, test } from 'bun:test';
import { matchQuery, type SearchField } from './fuzzy.ts';
import {
  enLayoutToRu,
  queryVariants,
  ruLayoutToEn,
  transliterateEnToRu,
  transliterateRuToEn,
} from './layout.ts';

interface Entry {
  readonly en: string;
  readonly ru: string;
  readonly keywords?: readonly string[];
}

const ENTRIES: readonly Entry[] = [
  { en: 'Sort elements', ru: 'Сортировать элементы', keywords: ['sort', 'order', 'сортировка'] },
  { en: 'Toggle grid', ru: 'Показать или скрыть сетку', keywords: ['honeycomb', 'сетка'] },
  { en: 'Theme: dark or light', ru: 'Тема: тёмная или светлая', keywords: ['appearance', 'тема'] },
  { en: 'Undo', ru: 'Отменить', keywords: ['revert', 'отмена'] },
  { en: 'Redo', ru: 'Повторить' },
  { en: 'Duplicate selection', ru: 'Дублировать выбранное', keywords: ['copy', 'clone'] },
  { en: 'Open settings', ru: 'Открыть настройки', keywords: ['preferences'] },
  { en: 'Lock selection', ru: 'Заблокировать выбранное', keywords: ['pin'] },
  { en: 'Fit view to wall', ru: 'Показать всю стену', keywords: ['zoom', 'fit'] },
];

function fieldsOf(entry: Entry, locale: 'en' | 'ru'): readonly SearchField[] {
  const [primary, other] = locale === 'en' ? [entry.en, entry.ru] : [entry.ru, entry.en];
  return [
    { text: primary, weight: 1 },
    { text: other, weight: 0.95 },
    ...(entry.keywords ?? []).map((text) => ({ text, weight: 0.8 })),
  ];
}

function search(query: string, locale: 'en' | 'ru' = 'en'): readonly string[] {
  return ENTRIES.map((entry) => ({ entry, match: matchQuery(query, fieldsOf(entry, locale)) }))
    .filter((hit) => hit.match !== null)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .map((hit) => hit.entry.en);
}

describe('layout and transliteration helpers', () => {
  test('wrong-layout round trips', () => {
    expect(ruLayoutToEn('ыщкеу')).toBe('sorte');
    expect(ruLayoutToEn('ыщке')).toBe('sort');
    expect(enLayoutToRu('ntvf')).toBe('тема');
    expect(enLayoutToRu(ruLayoutToEn('тема'))).toBe('тема');
  });

  test('transliteration both ways', () => {
    expect(transliterateRuToEn('сорт')).toBe('sort');
    expect(transliterateRuToEn('щётка')).toBe('schyotka');
    expect(transliterateEnToRu('tema')).toBe('тема');
    expect(transliterateEnToRu('shablon')).toBe('шаблон');
    expect(transliterateEnToRu('chasy')).toBe('часы');
  });

  test('query variants cover the plausible readings', () => {
    expect(queryVariants('  Тема ').map((v) => v.text)).toEqual(['тема', 'ntvf', 'tema']);
    expect(queryVariants('sort').map((v) => [v.kind, v.text])).toEqual([
      ['original', 'sort'],
      ['layout', 'ыщке'],
      ['translit', 'сорт'],
    ]);
    expect(queryVariants('   ')).toEqual([]);
  });
});

describe('fuzzy matching', () => {
  test('subsequence matches, non-subsequences do not', () => {
    expect(matchQuery('tgrd', [{ text: 'Toggle grid', weight: 1 }])).not.toBeNull();
    expect(matchQuery('xyz', [{ text: 'Toggle grid', weight: 1 }])).toBeNull();
  });

  test('word starts and consecutive runs beat scattered matches', () => {
    const boundary = matchQuery('tg', [{ text: 'Toggle grid', weight: 1 }]);
    const scattered = matchQuery('tg', [{ text: 'Settings gizmo', weight: 1 }]);
    const inner = matchQuery('og', [{ text: 'Toggle grid', weight: 1 }]);
    expect(boundary && scattered && boundary.score).toBeGreaterThan(scattered?.score ?? 0);
    expect(boundary && inner && boundary.score).toBeGreaterThan(inner?.score ?? 0);
    const consecutive = matchQuery('sort', [{ text: 'Sort elements', weight: 1 }]);
    const spread = matchQuery('sort', [{ text: 'Select all reorder things', weight: 1 }]);
    expect(consecutive && spread && consecutive.score).toBeGreaterThan(spread?.score ?? 0);
  });

  test('exact and prefix matches rank above the same text inside a longer one', () => {
    const exact = matchQuery('undo', [{ text: 'Undo', weight: 1 }]);
    const longer = matchQuery('undo', [{ text: 'Undo last wall operation', weight: 1 }]);
    expect(exact && longer && exact.score).toBeGreaterThan(longer?.score ?? 0);
  });

  test('every word of a multi-word query must match', () => {
    expect(matchQuery('toggle grid', [{ text: 'Toggle grid', weight: 1 }])).not.toBeNull();
    expect(matchQuery('grid toggle', [{ text: 'Toggle grid', weight: 1 }])).not.toBeNull();
    expect(matchQuery('toggle sort', [{ text: 'Toggle grid', weight: 1 }])).toBeNull();
    expect(
      matchQuery('grid honeycomb', [
        { text: 'Toggle grid', weight: 1 },
        { text: 'honeycomb', weight: 0.8 },
      ]),
    ).not.toBeNull();
  });

  test('positions point into the first field for highlighting', () => {
    const result = matchQuery('tg', [{ text: 'Toggle grid', weight: 1 }]);
    expect(result?.positions).toEqual([0, 7]);
    const other = matchQuery('honey', [
      { text: 'Toggle grid', weight: 1 },
      { text: 'honeycomb', weight: 0.8 },
    ]);
    expect(other?.positions).toEqual([]);
  });

  test('case and ё are folded', () => {
    expect(matchQuery('ТЁМНАЯ', [{ text: 'темная', weight: 1 }])).not.toBeNull();
    expect(matchQuery('TOGGLE', [{ text: 'toggle grid', weight: 1 }])).not.toBeNull();
  });
});

describe('long fields', () => {
  const description = 'Show the element bank on the left';

  test('a scattered subsequence in a sentence is not a match', () => {
    expect(matchQuery('tema', [{ text: description, weight: 0.8 }])).toBeNull();
    expect(
      matchQuery('тема', [{ text: 'Показывать банк элементов слева', weight: 0.8 }]),
    ).toBeNull();
  });

  test('a word prefix in a sentence is', () => {
    expect(matchQuery('elem', [{ text: description, weight: 0.8 }])).not.toBeNull();
    expect(matchQuery('bank left', [{ text: description, weight: 0.8 }])).not.toBeNull();
  });
});

describe('long titles keep subsequence and typo matching', () => {
  test('a 30-character title is still found by a typo', () => {
    expect(
      matchQuery('keybord', [{ text: 'Customise keyboard shortcuts…', weight: 1 }]),
    ).not.toBeNull();
    expect(
      matchQuery('setings', [{ text: 'Reset all settings to defaults', weight: 1 }]),
    ).not.toBeNull();
  });
});

describe('rewritten readings stay tight', () => {
  test('"тема" does not match unrelated titles through scattered letters', () => {
    for (const title of [
      'Snap to honeycomb grid',
      'Chord timeout (ms)',
      'AI actions need approval',
    ]) {
      expect(matchQuery('тема', [{ text: title, weight: 1 }])).toBeNull();
    }
    expect(
      matchQuery('тема', [
        { text: 'Theme', weight: 0.8 },
        { text: 'Тема', weight: 1 },
      ]),
    ).not.toBeNull();
  });
});

describe('ranking across English and Russian', () => {
  test('English queries', () => {
    expect(search('sort')[0]).toBe('Sort elements');
    expect(search('undo')[0]).toBe('Undo');
    expect(search('grid')[0]).toBe('Toggle grid');
    expect(search('dup')[0]).toBe('Duplicate selection');
  });

  test('Russian queries find the Russian titles and keywords', () => {
    expect(search('тема', 'ru')[0]).toBe('Theme: dark or light');
    expect(search('сетка', 'ru')[0]).toBe('Toggle grid');
    expect(search('отм', 'ru')[0]).toBe('Undo');
    expect(search('настр', 'ru')[0]).toBe('Open settings');
  });

  test('a Russian query finds an English-only keyword through transliteration', () => {
    expect(search('сорт')[0]).toBe('Sort elements');
    expect(search('дарк')[0]).toBe('Theme: dark or light');
  });

  test('a Latin transliteration finds Russian text', () => {
    expect(search('tema', 'ru')[0]).toBe('Theme: dark or light');
    expect(search('setka', 'ru')[0]).toBe('Toggle grid');
  });

  test('wrong layout: Russian letters typed for an English word', () => {
    expect(search('ыщке')[0]).toBe('Sort elements');
    expect(search('ыщкеу')[0]).toBe('Sort elements');
    expect(search('гтвщ')[0]).toBe('Undo');
    expect(search('пкшв')[0]).toBe('Toggle grid');
  });

  test('wrong layout: English letters typed for a Russian word', () => {
    expect(search('ntvf', 'ru')[0]).toBe('Theme: dark or light');
    expect(search('ctnrf', 'ru')[0]).toBe('Toggle grid');
  });

  test('a single missing or extra letter on longer words is forgiven', () => {
    expect(search('sorte')[0]).toBe('Sort elements');
    expect(search('toggel')[0]).toBe('Toggle grid');
  });

  test('gibberish matches nothing', () => {
    expect(search('qqqxz')).toEqual([]);
  });
});
