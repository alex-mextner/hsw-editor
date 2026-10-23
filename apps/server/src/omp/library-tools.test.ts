import { describe, expect, test } from 'bun:test';
import { createEmptyWall } from '@hsw-editor/core';
import type { HolderEvaluation } from '@hsw-editor/compat';
import {
  filterLibraryTools,
  libraryToolLabel,
  type LibraryToolSummary,
  pickMount,
  tagCounts,
} from './library-tools.ts';

const tool = (id: string, extra: Partial<LibraryToolSummary> = {}): LibraryToolSummary => ({
  id,
  name: { en: id },
  classId: null,
  bankClass: null,
  tags: [],
  dimsMm: { x: 1, y: 1, z: 1 },
  holdingDims: {},
  ...extra,
});

describe('filterLibraryTools', () => {
  const library = [
    tool('sd', {
      name: { en: 'Screwdriver', ru: 'Отвёртка' },
      classId: 'screwdriver',
      bankClass: 'screwdriver',
      tags: ['carpet'],
    }),
    tool('pl', {
      name: { en: 'Pliers' },
      classId: 'pliers-combination',
      bankClass: 'pliers',
      tags: ['carpet', 'old'],
    }),
    tool('x'),
  ];
  const ids = (found: readonly LibraryToolSummary[]) => found.map((entry) => entry.id);

  test('no filter keeps the whole library', () => {
    expect(ids(filterLibraryTools(library, {}))).toEqual(['sd', 'pl', 'x']);
  });

  test('tag is an exact, case-folded match', () => {
    expect(ids(filterLibraryTools(library, { tag: ' CARPET ' }))).toEqual(['sd', 'pl']);
    expect(ids(filterLibraryTools(library, { tag: 'carp' }))).toEqual([]);
  });

  test('blank filters are no filters (a model sends "" for fields it does not use)', () => {
    expect(ids(filterLibraryTools(library, { tag: '', classId: ' ', text: '' }))).toEqual([
      'sd',
      'pl',
      'x',
    ]);
  });

  test('class matches the generator class or the bank class', () => {
    expect(ids(filterLibraryTools(library, { classId: 'pliers' }))).toEqual(['pl']);
    expect(ids(filterLibraryTools(library, { classId: 'pliers-combination' }))).toEqual(['pl']);
  });

  test('text needs every word in a name, class or tag; ё reads as е', () => {
    expect(ids(filterLibraryTools(library, { text: 'отвертка' }))).toEqual(['sd']);
    expect(ids(filterLibraryTools(library, { text: 'pliers old' }))).toEqual(['pl']);
    expect(ids(filterLibraryTools(library, { text: 'pliers carpet', tag: 'old' }))).toEqual(['pl']);
    expect(ids(filterLibraryTools(library, { text: 'hammer' }))).toEqual([]);
  });

  test('tag counts, most used first', () => {
    expect(tagCounts(library)).toEqual([
      { tag: 'carpet', count: 2 },
      { tag: 'old', count: 1 },
    ]);
    expect(libraryToolLabel({ id: 'a', name: { ru: 'Клещи' } })).toBe('Клещи');
    expect(libraryToolLabel({ id: 'a', name: {} })).toBe('a');
    // a cleared English name is stored as an empty string and is not a label
    expect(libraryToolLabel({ id: 'a', name: { en: '', ru: 'Клещи' } })).toBe('Клещи');
  });
});

describe('pickMount', () => {
  const wall = createEmptyWall('w', 'W');
  const evaluation = (
    holderId: string,
    ok: boolean,
    score: number,
    free: number,
  ): HolderEvaluation => ({
    holderId,
    compat: {
      ok,
      score,
      reasons: ok ? [] : [{ code: 'class_mismatch', params: {} }],
      clearances: [],
      entryIndex: null,
    },
    freeSlots: Array.from({ length: free }, (_, index) => ({
      slot: { index, anchor: [0, 0, 0] as [number, number, number] },
      world: [0, 0, 0] as [number, number, number],
    })),
  });

  test('picks the best scoring holder with a free slot, the first on a tie', () => {
    const picked = pickMount(
      wall,
      [evaluation('a', true, 0.7, 1), evaluation('b', true, 0.9, 1), evaluation('c', true, 0.9, 2)],
      {},
    );
    expect(picked).toEqual({ ok: true, holderId: 'b' });
  });

  test('skips full and unsuitable holders and explains each', () => {
    const picked = pickMount(
      wall,
      [evaluation('a', false, 0, 0), evaluation('b', true, 0.8, 0)],
      {},
    );
    expect(picked.ok).toBe(false);
    if (!picked.ok) {
      expect(picked.verdicts).toEqual([
        {
          holderId: 'a',
          fits: false,
          freeSlots: 0,
          reasons: ['class_mismatch'],
        },
        { holderId: 'b', fits: true, freeSlots: 0, reasons: [] },
      ]);
    }
  });

  test('an asked-for holder or slot is not replaced by another', () => {
    const evaluations = [evaluation('a', true, 0.7, 1), evaluation('b', true, 0.9, 3)];
    expect(pickMount(wall, evaluations, { holderId: 'a' })).toEqual({ ok: true, holderId: 'a' });
    expect(pickMount(wall, evaluations, { holderId: 'a', slot: 2 }).ok).toBe(false);
    expect(pickMount(wall, evaluations, { holderId: 'b', slot: 2 })).toEqual({
      ok: true,
      holderId: 'b',
    });
    const ghost = pickMount(wall, evaluations, { holderId: 'zzz' });
    expect(ghost.ok).toBe(false);
    expect(ghost).toMatchObject({ message: expect.stringContaining('no such item') });
  });
});
