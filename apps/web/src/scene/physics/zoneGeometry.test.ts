import { describe, expect, test } from 'bun:test';
import { createEmptyWall, type WallItem } from '@hsw-editor/core';
import { placeholderBounds } from '../itemBounds.ts';
import { physicsZoneGeometry } from './zoneGeometry.ts';

const wall = createEmptyWall('w', 'physics');

function tool(extra: Partial<WallItem> = {}): WallItem {
  return {
    id: 't',
    kind: 'tool',
    toolClass: 'caliper',
    pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
    ...extra,
  } as WallItem;
}

describe('physicsZoneGeometry', () => {
  test('a tool with no known size is marked on the same placeholder box the scene draws', () => {
    // Regression: itemBounds() returns null for a tool without a bank id and without dimensions, so its amber
    // stripes were never drawn although the report listed it.
    const geometry = physicsZoneGeometry(tool(), wall, new Map());
    expect(geometry).not.toBeNull();
    const placeholder = placeholderBounds(tool(), wall);
    expect(geometry?.dimsMm).toEqual(placeholder.dims);
    expect(geometry?.centreMm).toEqual(placeholder.centre);
    expect(geometry?.modelUrl).toBeNull();
  });

  test('a holder with no bank element has no zone', () => {
    const holder = tool({ kind: 'holder' });
    expect(physicsZoneGeometry(holder, wall, new Map())).toBeNull();
  });
});
