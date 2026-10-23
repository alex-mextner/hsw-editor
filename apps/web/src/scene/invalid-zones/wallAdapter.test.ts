import { describe, expect, test } from 'bun:test';
import { WallItemSchema, type WallItem } from '@hsw-editor/core';
import type { RegionMesh } from './engine.ts';
import { legendState, regionReasons } from './reasons.ts';
import { boxFromCentreDims, engineScene, type ItemSolid } from './wallAdapter.ts';

const holder = (id: string, x: number): WallItem =>
  WallItemSchema.parse({ id, kind: 'holder', bankId: 'h', pose: { x, y: 10 } });
const tool = (id: string, parentId: string): WallItem =>
  WallItemSchema.parse({ id, kind: 'tool', modelRefId: 'm', parentId });
const photo: WallItem = WallItemSchema.parse({ id: 'p', kind: 'photo-ref', photoId: 'ph' });

const solidOf = (item: WallItem): ItemSolid | null =>
  item.kind === 'photo-ref'
    ? null
    : {
        solidKey: item.kind === 'tool' ? 'box' : 'glb',
        source: {
          kind: 'box',
          box: boxFromCentreDims({ x: 0, y: 0, z: 5 }, { x: 10, y: 20, z: 10 }),
        },
      };

describe('engineScene', () => {
  test('keeps solids, drops photo references, collects each source once', () => {
    const scene = engineScene(
      [holder('a', 1), holder('b', 2), tool('t', 'a'), photo],
      solidOf,
      new Map(),
    );
    expect(scene.items.map((i) => i.id)).toEqual(['a', 'b', 't']);
    expect([...scene.sources.keys()].sort()).toEqual(['box', 'glb']);
    expect(scene.items[2]?.parentId).toBe('a');
  });

  test('a live drag pose replaces x, y and rotZ and nothing else', () => {
    const base = holder('a', 1);
    const scene = engineScene([base], solidOf, new Map([['a', { x: 50, y: 60, rotZ: 120 }]]));
    expect(scene.items[0]?.pose).toEqual({ ...base.pose, x: 50, y: 60, rotZ: 120 });
    expect(base.pose.x).toBe(1);
  });

  test('boxFromCentreDims is centre +- half the size', () => {
    expect(boxFromCentreDims({ x: 1, y: 2, z: 3 }, { x: 4, y: 6, z: 8 })).toEqual({
      min: { x: -1, y: -1, z: -1 },
      max: { x: 3, y: 5, z: 7 },
    });
  });
});

describe('regionReasons', () => {
  const overlap = (a: string, b: string) => ({
    kind: 'overlap' as const,
    itemId: a,
    otherId: b,
    depthMm: 1,
    volumeMm3: 1,
  });
  const out = (id: string, side: 'left' | 'top') => ({
    kind: 'out-of-board' as const,
    itemId: id,
    side,
    extentMm: 1,
    volumeMm3: 1,
  });
  const reasons = [
    overlap('a', 'b'),
    overlap('b', 'a'),
    overlap('a', 'c'),
    out('a', 'left'),
    out('a', 'top'),
  ];
  const region = (key: string, kind: RegionMesh['kind'], itemIds: string[]) => ({
    key,
    kind,
    itemIds,
  });

  test('an overlap region stands for both directions of its pair only', () => {
    expect(regionReasons(region('overlap:a:b', 'overlap', ['a', 'b']), reasons)).toEqual([
      overlap('a', 'b'),
      overlap('b', 'a'),
    ]);
  });

  test('a protrusion region stands for its own (item, side)', () => {
    expect(regionReasons(region('bounds:a:left', 'out-of-board', ['a']), reasons)).toEqual([
      out('a', 'left'),
    ]);
  });
});

describe('legendState', () => {
  const overlap = { kind: 'overlap' as const, itemId: 'a', otherId: 'b', depthMm: 1, volumeMm3: 1 };

  test('counts items, not reasons', () => {
    expect(
      legendState({
        reasons: [overlap, { ...overlap, itemId: 'b', otherId: 'a' }, { ...overlap, otherId: 'c' }],
        pending: [],
      }),
    ).toEqual({
      kind: 'count',
      items: 2,
    });
  });

  test('an answer that skipped loading models is "checking", never "none"', () => {
    expect(legendState({ reasons: [], pending: ['m1'] })).toEqual({ kind: 'checking' });
    expect(legendState({ reasons: [], pending: [] })).toEqual({ kind: 'none' });
    expect(legendState({ reasons: [overlap], pending: ['m1'] }).kind).toBe('count');
  });
});
