import { describe, expect, test } from 'bun:test';
import { createBank } from './bank.ts';
import { BankIndexSchema } from './schema.ts';
import { makeElement, makeIndex } from './testing.ts';
import { stemTerm } from './text.ts';
import { validateBankIndex } from './validate.ts';

const elements = [
  makeElement({
    id: 'screwdriver-rail-6',
    ru: 'Планка для 6 отвёрток',
    en: 'Screwdriver rail, 6 slots',
    category: 'holders/screwdrivers',
    tagsRu: ['отвертка', 'отвертки', 'планка'],
    tagsEn: ['screwdriver', 'rail'],
    toolClasses: ['screwdriver'],
    dims: [216, 52, 51],
  }),
  makeElement({
    id: 'screwdriver-clip',
    ru: 'Клипса для отвёртки',
    en: 'Clip-on screwdriver holder',
    category: 'holders/screwdrivers',
    tagsRu: ['отвертка'],
    tagsEn: ['screwdriver holder'],
    toolClasses: ['screwdriver'],
    dims: [30, 44, 15],
  }),
  makeElement({
    id: 'pliers-saddle',
    ru: 'Седло для плоскогубцев',
    en: 'Pliers saddle',
    category: 'holders/pliers',
    tagsRu: ['пассатижи', 'плоскогубцы'],
    tagsEn: ['pliers'],
    toolClasses: ['pliers'],
  }),
  makeElement({
    id: 'tape-holder-large',
    ru: 'Держатель скотча',
    en: 'Tape roll holder',
    category: 'holders/tape',
    tagsRu: ['скотч', 'изолента'],
    tagsEn: ['tape'],
    toolClasses: ['tape-roll'],
  }),
  makeElement({
    id: 'hook-40',
    ru: 'Крючок 40 мм',
    en: 'Hook 40 mm',
    category: 'hooks/hooks',
    tagsRu: ['крючок', 'крючки'],
    tagsEn: ['hook'],
  }),
  makeElement({
    id: 'cup-round',
    ru: 'Стакан круглый',
    en: 'Round cup',
    category: 'bins/cups',
    tagsRu: ['стакан'],
    tagsEn: ['cup', 'pen holder'],
    generated: true,
    family: 'cup',
  }),
  makeElement({
    id: 'cup-round-b',
    ru: 'Стакан круглый, высокий',
    en: 'Round cup, tall',
    category: 'bins/cups',
    tagsRu: ['стакан'],
    tagsEn: ['cup'],
    generated: true,
    family: 'cup',
  }),
];
const bank = createBank(makeIndex(elements));

describe('search ranking', () => {
  test('Russian word forms find the same elements (отвертка / отвёртки / отверток)', () => {
    for (const q of ['отвертка', 'отвёртки', 'отверток', 'ОТВЕРТКУ']) {
      const ids = bank.search(q).map((r) => r.element.id);
      expect(ids).toContain('screwdriver-rail-6');
      expect(ids).toContain('screwdriver-clip');
      expect(ids).not.toContain('pliers-saddle');
    }
  });

  test('"screwdriver holder" ranks the element named holder first and excludes unrelated ones', () => {
    const results = bank.search('screwdriver holder');
    expect(results[0]?.element.id).toBe('screwdriver-clip');
    expect(results.map((r) => r.element.id)).not.toContain('hook-40');
  });

  test('"отвертка клипса" ranks the element that matches both words first', () => {
    expect(bank.search('отвертка клипса')[0]?.element.id).toBe('screwdriver-clip');
  });

  test('limit 0 returns nothing', () => {
    expect(bank.search('отвертка', {}, 0)).toEqual([]);
  });

  test('tool-class synonyms are searchable', () => {
    expect(bank.search('long nose pliers').map((r) => r.element.id)).toEqual(['pliers-saddle']);
  });

  test('stop words and empty queries return nothing instead of everything', () => {
    expect(bank.search('для')).toEqual([]);
    expect(bank.search('   ')).toEqual([]);
  });

  test('filter restricts hits', () => {
    const ids = bank.search('отвертка', { maxDimsMm: { x: 100 } }).map((r) => r.element.id);
    expect(ids).toEqual(['screwdriver-clip']);
  });
});

describe('listElements', () => {
  test('category filter includes sub-categories', () => {
    expect(bank.listElements({ category: 'holders' }).total).toBe(4);
    expect(bank.listElements({ category: 'holders/pliers' }).items.map((e) => e.id)).toEqual([
      'pliers-saddle',
    ]);
  });

  test('pagination reports the unpaged total', () => {
    const page = bank.listElements({ sort: 'name-en', offset: 1, limit: 2 });
    expect(page.total).toBe(7);
    expect(page.items).toHaveLength(2);
  });

  test('fits filter checks tool class and dimension ranges', () => {
    const withRange = makeElement({
      id: 'a',
      ru: 'А',
      en: 'A',
      category: 'holders/screwdrivers',
      toolClasses: ['screwdriver'],
    });
    withRange.fitsTool = [
      { toolClass: 'screwdriver', dims: { shaftDiameter: { min: 4, max: 7 } } },
    ];
    const b = createBank(makeIndex([withRange]));
    expect(
      b.listElements({ fits: { toolClass: 'screwdriver', dims: { shaftDiameter: 6 } } }).total,
    ).toBe(1);
    expect(
      b.listElements({ fits: { toolClass: 'screwdriver', dims: { shaftDiameter: 9 } } }).total,
    ).toBe(0);
    expect(b.listElements({ fits: { toolClass: 'pliers' } }).total).toBe(0);
  });

  test('family members are returned together', () => {
    const cup = bank.getElement('cup-round');
    expect(cup && bank.familyOf(cup).map((e) => e.id)).toEqual(['cup-round', 'cup-round-b']);
  });
});

describe('stemTerm', () => {
  test('unifies inflections and drops stop words', () => {
    expect(stemTerm('отвертки')).toBe(stemTerm('отвертка'));
    expect(stemTerm('holders')).toBe('holder');
    expect(stemTerm('boxes')).toBe('box');
    expect(stemTerm('для')).toBeNull();
    expect(stemTerm('M3')).toBe('m3');
  });
});

describe('validateBankIndex', () => {
  test('accepts a consistent index', () => {
    expect(validateBankIndex(makeIndex(elements)).ok).toBe(true);
  });

  test('rejects duplicate ids and duplicate source geometry', () => {
    const a = makeElement({
      id: 'a',
      ru: 'А',
      en: 'A',
      category: 'hooks',
      geometryHash: 'a'.repeat(64),
    });
    const b = makeElement({
      id: 'b',
      ru: 'Б',
      en: 'B',
      category: 'hooks',
      geometryHash: 'a'.repeat(64),
    });
    const sameGeometry = validateBankIndex(makeIndex([a, b]));
    expect(sameGeometry.ok).toBe(false);
    if (!sameGeometry.ok) expect(sameGeometry.errors.join('\n')).toContain('duplicate');
    expect(validateBankIndex(makeIndex([a, { ...a }])).ok).toBe(false);
  });

  test('a non-redistributable licence cannot be flagged redistributable', () => {
    const e = makeElement({ id: 'nc', ru: 'Н', en: 'NC', category: 'hooks' });
    e.license = { ...e.license, spdx: 'CC-BY-NC-4.0', redistributable: true };
    const result = validateBankIndex(makeIndex([e]));
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.join('\n')).toContain('must not be marked redistributable');
  });

  test('footprint invariants: anchor cell, parity', () => {
    const e = makeElement({ id: 'f', ru: 'Ф', en: 'F', category: 'hooks' });
    e.footprint = { cells: [{ dCol: 1, dRow2: 1 }], cols: 1, rows: 1 };
    expect(validateBankIndex(makeIndex([e])).ok).toBe(false);
    const odd = BankIndexSchema.safeParse({
      ...makeIndex([e]),
      elements: [{ ...e, footprint: { cells: [{ dCol: 1, dRow2: 0 }], cols: 1, rows: 1 } }],
    });
    expect(odd.success).toBe(false);
  });

  test('unknown category and tool class are reported', () => {
    const e = makeElement({ id: 'u', ru: 'У', en: 'U', category: 'nope', toolClasses: ['ghost'] });
    const result = validateBankIndex(makeIndex([e]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('unknown category');
      expect(result.errors.join('\n')).toContain('unknown tool class');
    }
  });

  test('counts must match the elements', () => {
    const index = makeIndex(elements);
    index.counts.total = 99;
    expect(validateBankIndex(index).ok).toBe(false);
  });
});
