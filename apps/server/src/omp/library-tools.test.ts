import { describe, expect, test } from 'bun:test';
import { applyOp, createEmptyWall, type WallItem, WallItemSchema } from '@hsw-editor/core';
import type { HolderEvaluation } from '@hsw-editor/compat';
import {
  BANK_ELEMENT_UNAVAILABLE,
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

  describe('holders and slots the agent has to hear about', () => {
    const item = (id: string, extra: Record<string, unknown>) =>
      WallItemSchema.parse({ id, source: { type: 'agent' }, ...extra });
    const built = (items: WallItem[]) =>
      applyOp(createEmptyWall('w', 'W'), {
        type: 'batch',
        ops: items.map((candidate) => ({ type: 'addItem', item: candidate })),
      }).wall;

    test('a holder whose bank element could not be fetched is in the verdicts with an explicit reason', () => {
      const wall = built([
        item('known', { kind: 'holder', bankId: 'rail' }),
        item('lost', { kind: 'holder', bankId: 'gone-from-bank' }),
      ]);
      const picked = pickMount(wall, [evaluation('known', true, 0.8, 0)], {});
      expect(picked.ok).toBe(false);
      if (picked.ok) return;
      expect(picked.verdicts).toContainEqual({
        holderId: 'lost',
        bankId: 'gone-from-bank',
        fits: false,
        freeSlots: 0,
        reasons: [BANK_ELEMENT_UNAVAILABLE],
      });
      expect(BANK_ELEMENT_UNAVAILABLE).toBe('bank element unavailable');
      expect(picked.verdicts.map((v) => v.holderId)).toEqual(['known', 'lost']);
    });

    test('asking for such a holder says its element is unavailable, in the message and in the verdict', () => {
      const wall = built([item('lost', { kind: 'holder', bankId: 'gone-from-bank' })]);
      const picked = pickMount(wall, [], { holderId: 'lost' });
      expect(picked).toMatchObject({
        ok: false,
        message: expect.stringContaining('bank element is not available'),
        verdicts: [{ holderId: 'lost', reasons: [BANK_ELEMENT_UNAVAILABLE] }],
      });
    });

    test('a slot taken on a compatible holder says it is taken and lists the free slots', () => {
      const wall = built([
        item('h', { kind: 'holder', bankId: 'rail' }),
        item('hammer', {
          kind: 'tool',
          bankId: 'tool-hammer',
          parentId: 'h',
          slot: 1,
          label: 'Hammer',
        }),
      ]);
      // slot 1 is taken, slots 0 and 2 are free
      const evaluations = [evaluation('h', true, 0.9, 3)].map((e) => ({
        ...e,
        freeSlots: e.freeSlots.filter((free) => free.slot.index !== 1),
      }));
      const picked = pickMount(wall, evaluations, { holderId: 'h', slot: 1 });
      expect(picked.ok).toBe(false);
      if (picked.ok) return;
      expect(picked.message).toContain('slot 1 of holder h is taken by Hammer');
      expect(picked.message).toContain('free slots: 0, 2');
      expect(picked.verdicts).toEqual([
        { holderId: 'h', bankId: 'rail', fits: true, freeSlots: 2, reasons: [] },
      ]);
    });

    test('a slot the holder does not have says so and lists the free ones; a full holder says none are free', () => {
      const wall = built([item('h', { kind: 'holder', bankId: 'rail' })]);
      const roomy = pickMount(wall, [evaluation('h', true, 0.9, 2)], { holderId: 'h', slot: 9 });
      expect(roomy).toMatchObject({
        ok: false,
        message: expect.stringContaining('holder h has no slot 9 (free slots: 0, 1)'),
      });
      const full = pickMount(wall, [evaluation('h', true, 0.9, 0)], { holderId: 'h', slot: 0 });
      expect(full).toMatchObject({ ok: false, message: expect.stringContaining('none free') });
    });

    test('a holder that does not take the tool keeps the compatibility refusal, not a slot message', () => {
      const wall = built([item('h', { kind: 'holder', bankId: 'rail' })]);
      const picked = pickMount(wall, [evaluation('h', false, 0, 0)], { holderId: 'h', slot: 0 });
      expect(picked).toMatchObject({
        ok: false,
        message: expect.stringContaining('does not take this tool'),
      });
    });
  });
});
