import { describe, expect, test } from 'bun:test';
import { createBank } from './bank.ts';
import { buildSearchIndex, loadSearchIndex, serializeSearchIndex } from './search.ts';
import { BankIndexSchema, type ToolClass } from './schema.ts';
import { makeElement, makeIndex } from './testing.ts';
import { stemTerm } from './text.ts';
import { TOOL_CLASSES } from './toolClasses.ts';
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
    expect(bank.search('combination pliers').map((r) => r.element.id)).toEqual(['pliers-saddle']);
    // A word of a finer class (long-nose-pliers) finds the holder of the coarse class it refines.
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

  test('a negative offset starts at the first element; limit 0 returns no items', () => {
    const first = bank.listElements({ sort: 'name-en', offset: 0, limit: 2 });
    expect(bank.listElements({ sort: 'name-en', offset: -1, limit: 2 }).items).toEqual(first.items);
    const none = bank.listElements({ limit: 0 });
    expect(none.items).toHaveLength(0);
    expect(none.total).toBe(7);
  });

  test('fits filter checks tool class and dimension ranges', () => {
    const withRange = makeElement({
      id: 'a',
      ru: 'А',
      en: 'A',
      category: 'holders/screwdrivers',
      toolClasses: ['screwdriver'],
      fitsTool: [{ toolClass: 'screwdriver', dims: { shaftDiameter: { min: 4, max: 7 } } }],
    });
    const b = createBank(makeIndex([withRange]));
    expect(
      b.listElements({ fits: { toolClass: 'screwdriver', dims: { shaftDiameter: 6 } } }).total,
    ).toBe(1);
    expect(
      b.listElements({ fits: { toolClass: 'screwdriver', dims: { shaftDiameter: 9 } } }).total,
    ).toBe(0);
    expect(b.listElements({ fits: { toolClass: 'pliers' } }).total).toBe(0);
  });

  test('a holder of the coarse class is found by the words of its finer classes', () => {
    const sawRack = makeElement({
      id: 'saw-rack',
      ru: 'Стойка',
      en: 'Rack',
      category: 'holders/saws',
      toolClasses: ['saw'],
    });
    const b = createBank(makeIndex([sawRack]));
    expect(b.search('hacksaw').map((r) => r.element.id)).toEqual(['saw-rack']);
    expect(b.search('ножовка по металлу').map((r) => r.element.id)).toEqual(['saw-rack']);
  });

  test('the toolClass filter keeps the holders of the coarser class a finer class refines', () => {
    const knifeBlock = makeElement({
      id: 'knife-block',
      ru: 'Н',
      en: 'Knife block',
      category: 'holders/knives',
      toolClasses: ['knife'],
    });
    const b = createBank(makeIndex([knifeBlock]));
    expect(b.listElements({ toolClass: 'chisel' }).total).toBe(1);
    expect(b.listElements({ toolClass: 'hacksaw' }).total).toBe(0);
  });

  test('fits filter also matches holders of the coarser class a finer class refines', () => {
    const knifeBlock = makeElement({
      id: 'knife-block',
      ru: 'Н',
      en: 'Knife block',
      category: 'holders/knives',
      toolClasses: ['knife'],
      fitsTool: [{ toolClass: 'knife' }],
    });
    const b = createBank(makeIndex([knifeBlock]));
    expect(b.listElements({ fits: { toolClass: 'chisel' } }).total).toBe(1);
    expect(b.listElements({ fits: { toolClass: 'hacksaw' } }).total).toBe(0);
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

  test('keeps the breve of й so masculine adjective endings stem like the other forms', () => {
    expect(stemTerm('большой')).toBe(stemTerm('большая'));
    expect(stemTerm('большой')).toBe('больш');
    expect(stemTerm('красный')).toBe(stemTerm('красная'));
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

  test('a broader link must name a declared class that is not itself refined', () => {
    const toolClasses = (links: Record<string, string>): ToolClass[] =>
      TOOL_CLASSES.map((t) => {
        const broader = links[t.id];
        return broader === undefined ? t : { ...t, broader };
      });
    const errors = (index: ReturnType<typeof makeIndex>): string => {
      const result = validateBankIndex(index);
      return result.ok ? '' : result.errors.join('\n');
    };
    const base = makeIndex([]);
    expect(errors({ ...base, toolClasses: toolClasses({}) })).toBe('');
    expect(errors({ ...base, toolClasses: toolClasses({ knife: 'nowhere' }) })).toContain(
      'unknown broader class nowhere',
    );
    // chisel -> knife is built in; knife -> saw would make a chain.
    expect(errors({ ...base, toolClasses: toolClasses({ knife: 'saw' }) })).toContain('no chains');
    // An index that declares only some classes: the built-in chisel -> knife link is checked too.
    const declared = toolClasses({ knife: 'saw' }).filter((t) => t.id !== 'chisel');
    expect(errors({ ...base, toolClasses: declared })).toContain('chisel');
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

  test('the categories and tool classes the index declares are the vocabulary', () => {
    const e = makeElement({
      id: 'm',
      ru: 'М',
      en: 'M',
      category: 'holders/magnetic',
      toolClasses: ['screwdriver'],
    });
    const index = makeIndex([e]);
    expect(validateBankIndex(index).ok).toBe(false);
    index.categories = [
      ...index.categories,
      {
        id: 'holders/magnetic',
        parent: 'holders',
        name: { ru: 'Магнитные', en: 'Magnetic' },
        order: 99,
      },
    ];
    expect(validateBankIndex(index).ok).toBe(true);
    expect(createBank(index).search('magnetic')).toHaveLength(1);
  });

  test('counts must match the elements', () => {
    const index = makeIndex(elements);
    index.counts.total = 99;
    expect(validateBankIndex(index).ok).toBe(false);
  });
});

describe('serialised search index', () => {
  const contentHash = 'a'.repeat(64);
  const index = { ...makeIndex(elements), contentHash };

  test('a matching serialised index is used and answers like a rebuilt one', () => {
    const serialized = serializeSearchIndex(buildSearchIndex(elements), contentHash);
    const loaded = createBank(index, serialized);
    expect(loaded.search('отвертка').map((r) => r.element.id)).toEqual(
      createBank(index)
        .search('отвертка')
        .map((r) => r.element.id),
    );
  });

  test('wrong bank hash, wrong version and corrupt JSON fall back to a rebuild', () => {
    const serialized = serializeSearchIndex(buildSearchIndex(elements), 'b'.repeat(64));
    expect(loadSearchIndex(serialized, contentHash)).toBeNull();
    expect(loadSearchIndex('{"searchIndexVersion":0}', contentHash)).toBeNull();
    expect(loadSearchIndex('{not json', contentHash)).toBeNull();
    expect(createBank(index, '{not json').search('отвертка').length).toBeGreaterThan(0);
  });
});

describe('listElements filters', () => {
  test('size, cell count, family, generated and licence filters', () => {
    expect(bank.listElements({ minDimsMm: { x: 100 } }).items.map((e) => e.id)).toEqual([
      'screwdriver-rail-6',
    ]);
    expect(bank.listElements({ maxCells: 0 }).total).toBe(0);
    expect(bank.listElements({ family: 'cup' }).total).toBe(2);
    expect(bank.listElements({ generated: true }).total).toBe(2);
    const nc = createBank(
      makeIndex([
        makeElement({ id: 'free', ru: 'А', en: 'A', category: 'hooks' }),
        makeElement({ id: 'nc', ru: 'Б', en: 'B', category: 'hooks', redistributable: false }),
      ]),
    );
    expect(nc.listElements({ redistributable: false }).items.map((e) => e.id)).toEqual(['nc']);
  });

  test('Russian adjectives ending in й match across forms (круглый / круглая / круглого)', () => {
    for (const q of ['круглый', 'круглая', 'круглого']) {
      expect(bank.search(q).map((r) => r.element.id)).toContain('cup-round');
    }
  });
});
