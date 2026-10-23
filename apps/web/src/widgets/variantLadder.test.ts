import { describe, expect, test } from 'bun:test';
import type { BankElement } from '@hsw-editor/bank';
import type { WallItem } from '@hsw-editor/core';
import { hasLadder, ladderReasonKey, rungsOf, snapToLadder, switchOps } from './variantLadder.ts';

function element(id: string, y: number, extra: Partial<BankElement> = {}): BankElement {
  return { id, dimsMm: { x: 56, y, z: 40 }, ...extra } as unknown as BankElement;
}

const family = [element('h-80', 80), element('h-120', 120), element('h-160', 160)];

describe('snapToLadder', () => {
  test('lands a typed height on the nearest rung and names both neighbours', () => {
    const result = snapToLadder(family, 'y', 130, family[0]);
    expect(result.chosen?.element.id).toBe('h-120');
    expect(result.below?.element.id).toBe('h-80');
    expect(result.above?.element.id).toBe('h-160');
    expect(result.reason.code).toBe('nearest-variant');
  });

  test('a size that is a rung is exact, with no neighbour past the ends', () => {
    const result = snapToLadder(family, 'y', 160, family[0]);
    expect(result.chosen?.element.id).toBe('h-160');
    expect(result.reason.code).toBe('exact');
    expect(result.above).toBeNull();
    expect(ladderReasonKey(result.reason)).toBe('photo.snap.exact');
  });

  test('a size past the largest rung is the largest rung', () => {
    expect(snapToLadder(family, 'y', 900, undefined).chosen?.element.id).toBe('h-160');
    expect(snapToLadder(family, 'y', 1, undefined).chosen?.element.id).toBe('h-80');
  });

  test('a dimension every sibling shares has a single rung and nothing to choose', () => {
    expect(rungsOf(family, 'x', undefined)).toHaveLength(1);
    expect(snapToLadder(family, 'x', 90, undefined).below).toBeNull();
  });
});

describe('rungsOf', () => {
  test('siblings of equal size are one rung, and the item’s own element represents it', () => {
    const twins = [element('a', 100), element('b', 100), element('c', 140)];
    expect(rungsOf(twins, 'y', undefined).map((rung) => rung.element.id)).toEqual(['a', 'c']);
    expect(rungsOf(twins, 'y', twins[1]).map((rung) => rung.element.id)).toEqual(['b', 'c']);
  });
});

describe('rungsOf in a family that varies in two axes', () => {
  const grid = [
    element('56x80', 80, { dimsMm: { x: 56, y: 80, z: 40 } } as Partial<BankElement>),
    element('56x120', 120, { dimsMm: { x: 56, y: 120, z: 40 } } as Partial<BankElement>),
    element('80x80', 80, { dimsMm: { x: 80, y: 80, z: 40 } } as Partial<BankElement>),
    element('80x120', 120, { dimsMm: { x: 80, y: 120, z: 40 } } as Partial<BankElement>),
  ];

  test('a rung shared by several siblings is the one that keeps the other sizes of the current element', () => {
    const current = grid[2];
    const rungs = rungsOf(grid, 'y', current);
    expect(rungs.map((rung) => rung.element.id)).toEqual(['80x80', '80x120']);
    expect(snapToLadder(grid, 'y', 118, current).chosen?.element.id).toBe('80x120');
  });

  test('a switch that changes another size says so', () => {
    const [narrow, , , wide] = grid;
    if (!narrow || !wide) throw new Error('fixture');
    const result = snapToLadder([narrow, wide], 'y', 120, narrow);
    expect(result.chosen?.element.id).toBe('80x120');
    expect(result.alsoChanged).toEqual([{ key: 'x', fromMm: 56, toMm: 80 }]);
    expect(snapToLadder(grid, 'y', 120, grid[2]).alsoChanged).toEqual([]);
  });

  test('from the narrow current element the narrow sibling stands for the tall rung', () => {
    expect(snapToLadder(grid, 'y', 120, grid[0]).chosen?.element.id).toBe('56x120');
  });
});

describe('hasLadder', () => {
  test('is true for a family of different sizes and false for a lone element or identical twins', () => {
    expect(hasLadder(family)).toBe(true);
    expect(hasLadder([element('solo', 80)])).toBe(false);
    expect(hasLadder([element('a', 80), element('b', 80)])).toBe(false);
  });
});

describe('switchOps', () => {
  test('swaps the variant and drops params the new element does not define', () => {
    const item = { id: 'i1', params: { slots: 4, length: 90 } } as unknown as WallItem;
    const target = element('h-120', 120, {
      params: [
        {
          key: 'length',
          label: { ru: 'l', en: 'l' },
          unit: 'mm',
          min: 1,
          max: 9,
          default: 2,
          step: 1,
        },
      ],
    });
    expect(switchOps(item, target)).toEqual([
      { type: 'setVariant', id: 'i1', variantId: 'h-120', bankId: 'h-120' },
      { type: 'setParams', id: 'i1', unset: ['slots'] },
    ]);
  });
});
