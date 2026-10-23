import { describe, expect, test } from 'bun:test';
import { ModelRefSchema, WallItemSchema, type ModelRef, type WallItem } from '@hsw-editor/core';
import {
  buildAcceptOps,
  buildRejectOps,
  deltaTone,
  dimensionDelta,
  pickCompareIds,
  referenceFor,
  safeExternalUrl,
} from './compareMath.ts';

function model(id: string, extra: Record<string, unknown> = {}): ModelRef {
  return ModelRefSchema.parse({ id, label: id, source: { type: 'web' }, ...extra });
}

function item(extra: Record<string, unknown> = {}): WallItem {
  return WallItemSchema.parse({ id: 'i1', kind: 'tool', modelRefId: 'm1', ...extra });
}

describe('dimension deltas', () => {
  test('delta is candidate minus reference per axis', () => {
    expect(dimensionDelta({ x: 12, y: 30, z: 5 }, { x: 10, y: 30, z: 6 })).toEqual({
      x: 2,
      y: 0,
      z: -1,
    });
  });

  test('tone separates noise, small and large differences', () => {
    expect(deltaTone(0.4, 10)).toBe('same');
    expect(deltaTone(2, 200)).toBe('same');
    expect(deltaTone(10, 200)).toBe('minor');
    expect(deltaTone(-40, 200)).toBe('major');
  });

  test('reference is the item dims, else the mean of the other candidates with dims', () => {
    const a = model('a', { dimensionsMm: { x: 10, y: 20, z: 30 } });
    const b = model('b', { dimensionsMm: { x: 20, y: 40, z: 50 } });
    const c = model('c');
    expect(referenceFor(a, { x: 1, y: 2, z: 3 }, [a, b, c])).toEqual({
      dims: { x: 1, y: 2, z: 3 },
      source: 'item',
    });
    expect(referenceFor(a, null, [a, b, c])).toEqual({
      dims: { x: 20, y: 40, z: 50 },
      source: 'others',
    });
    expect(referenceFor(c, null, [c])).toBeNull();
  });
});

describe('pickCompareIds', () => {
  test('open candidates by score first, rejected last, capped', () => {
    const models = [
      model('r', { status: 'rejected', score: 0.99 }),
      model('lo', { score: 0.2 }),
      model('hi', { score: 0.9 }),
      model('none'),
      model('ch', { status: 'chosen' }),
    ];
    expect(pickCompareIds(models, 4)).toEqual(['hi', 'lo', 'none', 'ch']);
  });
});

describe('buildAcceptOps', () => {
  test('chosen one is chosen, the rest rejected, untouched statuses emit nothing', () => {
    const a = model('a');
    const b = model('b');
    const c = model('c', { status: 'rejected' });
    expect(buildAcceptOps([a, b, c], 'b', undefined)).toEqual([
      { type: 'updateModelRef', id: 'a', patch: { status: 'rejected' } },
      { type: 'updateModelRef', id: 'b', patch: { status: 'chosen' } },
    ]);
  });

  test('a bank candidate also switches the item, unless the item is locked', () => {
    const bank = model('b', { bankId: 'hex-bit-holder' });
    const ops = buildAcceptOps([bank], 'b', item());
    expect(ops).toContainEqual({
      type: 'setVariant',
      id: 'i1',
      variantId: 'hex-bit-holder',
      bankId: 'hex-bit-holder',
    });
    expect(
      buildAcceptOps([bank], 'b', item({ locked: true })).some((op) => op.type === 'setVariant'),
    ).toBe(false);
  });
});

describe('buildRejectOps', () => {
  test('rejecting an already rejected model is a no-op', () => {
    expect(buildRejectOps(model('a', { status: 'rejected' }))).toEqual([]);
    expect(buildRejectOps(model('a'))).toHaveLength(1);
  });
});

describe('safeExternalUrl', () => {
  test('only http(s) is linkable', () => {
    expect(safeExternalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
  });
});
