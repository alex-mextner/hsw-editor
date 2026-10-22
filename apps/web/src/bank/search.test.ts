import { describe, expect, test } from 'bun:test';
import type { BankElement, BankIndex } from '@hsw-editor/bank';
import { createBankSearch, highlightSegments, normalizeTerm } from './search.ts';

function element(
  id: string,
  ru: string,
  en: string,
  tagsRu: string[],
  category: string,
): BankElement {
  return {
    id,
    name: { ru, en },
    tags: { ru: tagsRu, en: [] },
    category,
    toolClasses: ['screwdriver'],
  } as unknown as BankElement;
}

const index = {
  categories: [
    { id: 'holders', name: { ru: 'Держатели', en: 'Holders' }, order: 1 },
    {
      id: 'holders/screwdrivers',
      parent: 'holders',
      name: { ru: 'Отвёртки', en: 'Screwdriver holders' },
      order: 2,
    },
    { id: 'hooks', name: { ru: 'Крючки', en: 'Hooks' }, order: 3 },
  ],
  toolClasses: [
    {
      id: 'screwdriver',
      name: { ru: 'Отвёртка', en: 'Screwdriver' },
      synonyms: { ru: ['отвертка'], en: ['driver'] },
    },
  ],
  elements: [
    element(
      'sd-6',
      'Держатель отвёртки на 6',
      'Screwdriver holder x6',
      ['шлицевая'],
      'holders/screwdrivers',
    ),
    element('hook-1', 'Крючок одинарный', 'Single hook', ['скоба'], 'hooks'),
    element('hook-2', 'Крючок двойной', 'Double hook', [], 'hooks'),
  ],
} as unknown as BankIndex;

describe('bank search', () => {
  const engine = createBankSearch(index);

  test('ё and е are the same letter in queries', () => {
    expect(normalizeTerm('Отвёртка')).toBe(normalizeTerm('отвертка'));
    expect(engine.search('отвертка')[0]).toBe('sd-6');
    expect(engine.search('отвёртки')[0]).toBe('sd-6');
  });

  test('matches prefixes, English names and tags, and requires every word', () => {
    expect(engine.search('крюч')).toEqual(expect.arrayContaining(['hook-1', 'hook-2']));
    expect(engine.search('single')).toEqual(['hook-1']);
    expect(engine.search('шлицев')).toEqual(['sd-6']);
    expect(engine.search('крючок двойной')).toEqual(['hook-2']);
  });

  test('an empty query lists everything and a miss lists nothing', () => {
    expect(engine.search('  ')).toHaveLength(3);
    expect(engine.search('zzzzzz')).toEqual([]);
  });
});

describe('highlightSegments', () => {
  test('marks the matched word starts and keeps the original casing', () => {
    expect(highlightSegments('Держатель Отвёртки', 'отверт')).toEqual([
      { text: 'Держатель ', match: false },
      { text: 'Отвёрт', match: true },
      { text: 'ки', match: false },
    ]);
  });

  test('does not mark matches inside a word', () => {
    expect(highlightSegments('keyboard', 'or')).toEqual([{ text: 'keyboard', match: false }]);
  });
});
