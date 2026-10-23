import { describe, expect, test } from 'bun:test';
import type { ToolClassInfo, ToolSummary } from './api.ts';
import {
  buildEntries,
  createLibrarySearch,
  entryName,
  filterEntries,
  groupEntries,
  NO_QUERY,
  tagCounts,
} from './model.ts';

const label = (en: string, ru: string) => ({ en, ru });

function cls(
  id: string,
  family: string,
  name: { en: string; ru: string },
  keywords: { en: string[]; ru: string[]} = { en: [], ru: [] },
): ToolClassInfo {
  return {
    id,
    family,
    familyLabel: label(`${family} family`, `семейство ${family}`),
    name,
    bankClass: id,
    keywords,
    schema: {},
    presets: [],
    dimsMm: { x: 20, y: 200, z: 20 },
    holdingDims: { shaftDiameter: 6 },
  };
}

const CLASSES = [
  cls('screwdriver', 'drivers', label('Screwdriver', 'Отвёртка'), {
    en: ['phillips', 'flathead'],
    ru: ['крестовая'],
  }),
  cls('hex-key', 'drivers', label('Hex key', 'Шестигранник')),
  cls('hammer', 'striking', label('Hammer', 'Молоток')),
];

function tool(id: string, classId: string | null, tags: string[], name = { en: id, ru: id }): ToolSummary {
  return {
    id,
    name,
    classId,
    bankClass: classId,
    dimensionsMm: { length: 150, width: 20, thickness: 20, source: 'photo' },
    dimsMm: { x: 20, y: 150, z: 20 },
    holdingDims: {},
    tags,
    confidence: 0.8,
    createdAt: '2026-10-22T10:00:00Z',
    updatedAt: '2026-10-22T10:00:00Z',
    triangles: 100,
  };
}

const TOOLS = [
  tool('my-driver', 'screwdriver', ['garage', 'electric'], { en: 'My driver', ru: 'Моя отвёртка' }),
  tool('blob', null, ['garage']),
];

describe('buildEntries', () => {
  const entries = buildEntries(CLASSES, TOOLS);
  test('the user tools come first, then every class', () => {
    expect(entries.map((entry) => entry.key)).toEqual([
      'tool:my-driver',
      'tool:blob',
      'class:screwdriver',
      'class:hex-key',
      'class:hammer',
    ]);
  });
  test('a user tool sits in the family of its class, a generic loft in "other"', () => {
    expect(entries.find((entry) => entry.id === 'my-driver')?.group).toBe('drivers');
    expect(entries.find((entry) => entry.id === 'blob')?.group).toBe('other');
  });
  test('names fall back to the other language, then to the id', () => {
    const blob = entries.find((entry) => entry.id === 'blob');
    expect(blob && entryName(blob, 'ru')).toBe('blob');
    expect(entryName({ id: 'x', name: { en: 'Only', ru: '' } }, 'ru')).toBe('Only');
  });
  test('thumbnails are the generated class thumb or the tool thumb with a version', () => {
    expect(entries.find((entry) => entry.key === 'class:hammer')?.thumbUrl).toBe(
      '/api/tools/classes/hammer/thumb.webp',
    );
    expect(entries.find((entry) => entry.key === 'tool:blob')?.thumbUrl).toBe(
      '/api/tools/blob/thumb.webp?v=2026-10-22T10%3A00%3A00Z',
    );
  });
});

describe('search', () => {
  const entries = buildEntries(CLASSES, TOOLS);
  const search = createLibrarySearch(entries);
  const find = (text: string): string[] =>
    filterEntries(entries, { ...NO_QUERY, text }, search).map((entry) => entry.key);

  test('finds by English and Russian name, ё = е, and by prefix', () => {
    expect(find('screw')).toContain('class:screwdriver');
    expect(find('отвертка')).toEqual(expect.arrayContaining(['class:screwdriver', 'tool:my-driver']));
    expect(find('молот')).toEqual(['class:hammer']);
  });
  test('finds by keywords of the class and by the family name', () => {
    expect(find('phillips')).toContain('class:screwdriver');
    expect(find('крестовая')).toContain('class:screwdriver');
    expect(find('striking')).toEqual(['class:hammer']);
  });
  test('finds a user tool by its tag', () => {
    expect(find('electric')).toEqual(['tool:my-driver']);
  });
  test('an empty query keeps everything and nonsense finds nothing', () => {
    expect(find('')).toHaveLength(entries.length);
    expect(find('zzzzqqq')).toEqual([]);
  });
});

describe('filters', () => {
  const entries = buildEntries(CLASSES, TOOLS);
  const search = createLibrarySearch(entries);
  test('tags narrow to tools carrying all of them', () => {
    const keys = (tags: string[]): string[] =>
      filterEntries(entries, { ...NO_QUERY, tags }, search).map((entry) => entry.key);
    expect(keys(['garage'])).toEqual(['tool:my-driver', 'tool:blob']);
    expect(keys(['garage', 'electric'])).toEqual(['tool:my-driver']);
    expect(keys(['nope'])).toEqual([]);
  });
  test('"mine only" drops the built-in classes', () => {
    expect(
      filterEntries(entries, { ...NO_QUERY, mineOnly: true }, search).every((entry) => entry.kind === 'tool'),
    ).toBe(true);
  });
  test('tag counts are most used first', () => {
    expect(tagCounts(entries)).toEqual([
      ['garage', 2],
      ['electric', 1],
    ]);
  });
});

describe('groupEntries', () => {
  const entries = buildEntries(CLASSES, TOOLS);
  test('groups follow the class order, empty groups are dropped, "other" is last', () => {
    const groups = groupEntries(entries, CLASSES);
    expect(groups.map((group) => group.id)).toEqual(['drivers', 'striking', 'other']);
    expect(groups[0]?.entries.map((entry) => entry.key)).toEqual([
      'tool:my-driver',
      'class:screwdriver',
      'class:hex-key',
    ]);
  });
  test('a filtered list only keeps the groups with matches', () => {
    const search = createLibrarySearch(entries);
    const hits = filterEntries(entries, { ...NO_QUERY, text: 'hammer' }, search);
    expect(groupEntries(hits, CLASSES).map((group) => group.id)).toEqual(['striking']);
  });
});
