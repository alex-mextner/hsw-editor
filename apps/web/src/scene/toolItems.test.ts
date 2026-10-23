/** Tool items drawn by generated models: grouping, bounds, solids for the invalid-zone worker and the interface the hang maths reads. */
import { afterEach, describe, expect, test } from 'bun:test';
import { createEmptyWall, WallItemSchema, type ModelRef, type Wall } from '@hsw-editor/core';
import { toolAssetsStore } from '@/toolmodels/assets.ts';
import { classEntry, readyState } from '@/toolmodels/testing.ts';
import { toolInterfaceOf } from '@/wall/toolInterface.ts';
import { toolBox, toolBoxCentreOf } from '@/wall/attach.ts';
import { itemBounds } from './itemBounds.ts';
import { groupItems } from './itemGroups.ts';
import { itemSolid } from './invalid-zones/itemSolid.ts';

const screwdriver = classEntry('screwdriver', 'screwdriver');
const tapeRoll = classEntry('tape-roll', 'tape-roll');

afterEach(() => toolAssetsStore.set({ status: 'idle' }));

function model(id: string, by: string, toolClass: string): ModelRef {
  return {
    id,
    label: toolClass,
    status: 'chosen',
    source: { type: 'library', by },
    toolClass,
    dimensionsMm: { x: 28, y: 210, z: 28 },
  };
}

function tool(
  id: string,
  modelRefId: string,
  toolClass: string,
  params: Record<string, number> = {},
) {
  return WallItemSchema.parse({ id, kind: 'tool', modelRefId, toolClass, params });
}

function wallOf(): Wall {
  const wall = createEmptyWall('w-1', 'Wall');
  return {
    ...wall,
    models: [
      model('m-1', 'gen:screwdriver', 'screwdriver'),
      model('m-2', 'gen:screwdriver', 'screwdriver'),
      model('m-3', 'gen:tape-roll', 'tape-roll'),
      model('m-4', 'preset', 'usb-stick'),
    ],
    items: [
      tool('t-1', 'm-1', 'screwdriver'),
      tool('t-2', 'm-2', 'screwdriver'),
      tool('t-3', 'm-3', 'tape-roll'),
      tool('t-4', 'm-4', 'usb-stick'),
    ],
  };
}

describe('tools drawn by generated models', () => {
  test('once the tool index is loaded items of one class share one instanced group with the model box', () => {
    toolAssetsStore.set(readyState([screwdriver, tapeRoll]));
    const groups = groupItems(wallOf(), new Map(), true);
    const withModel = groups.filter(([, group]) => group.tool !== null);
    expect(withModel).toHaveLength(2);
    const drivers = withModel.find(([, group]) => group.tool?.entryId === 'class:screwdriver');
    expect(drivers?.[1].items.map((item) => item.id)).toEqual(['t-1', 't-2']);
    expect(drivers?.[1].boxMm).toEqual(screwdriver.dimsMm);
    expect(drivers?.[1].centreMm).toEqual(screwdriver.centreMm);
    const box = groups.filter(([, group]) => group.tool === null);
    expect(box).toHaveLength(1);
    expect(box[0]?.[1].items.map((item) => item.id)).toEqual(['t-4']);
    const ids = groups.flatMap(([, group]) => group.items.map((item) => item.id)).sort();
    expect(ids).toEqual(['t-1', 't-2', 't-3', 't-4']);
  });

  test('before the index arrives every tool is still drawn, as its stand-in box', () => {
    const groups = groupItems(wallOf(), new Map(), true);
    expect(groups.every(([, group]) => group.tool === null)).toBe(true);
    expect(groups.flatMap(([, group]) => group.items)).toHaveLength(4);
  });

  test('selection frame, drop ghost and hang maths see the model, not the preset box', () => {
    toolAssetsStore.set(readyState([screwdriver]));
    const wall = wallOf();
    const item = wall.items[0];
    if (!item) throw new Error('no item');
    expect(itemBounds(item, wall, new Map())).toEqual({
      dims: screwdriver.dimsMm,
      centre: screwdriver.centreMm,
    });
    expect(toolBox(item, wall)).toEqual(screwdriver.dimsMm);
    expect(toolBoxCentreOf(item, wall)).toEqual(screwdriver.centreMm);
    const ours = toolInterfaceOf(item, wall);
    expect(ours?.lengthMm).toBe(screwdriver.holding.lengthMm);
    expect(ours?.hang).toEqual(screwdriver.holding.hang);
    expect(ours?.maxSection).toEqual(screwdriver.holding.maxSection);
    expect(ours?.dims['shaftDiameter']).toBe(screwdriver.holding.dims['shaftDiameter']);
  });

  test('named dimensions of the item override what the model measures, box sizes never become holding dimensions', () => {
    toolAssetsStore.set(readyState([screwdriver]));
    const wall = wallOf();
    const base = wall.items[0];
    if (!base) throw new Error('no item');
    // `collarDiameter` is measured on the model but is not a class parameter: no rebuild, only a different holding dimension.
    const item = { ...base, params: { collarDiameter: 20, width: 25 } };
    const ours = toolInterfaceOf(item, wall);
    expect(ours?.dims['collarDiameter']).toBe(20);
    expect(ours?.dims['width']).toBeUndefined();
    expect(ours?.dims['shaftDiameter']).toBe(screwdriver.holding.dims['shaftDiameter']);
  });

  test('the invalid-zone worker gets the LOD1 model of a tool, a box for a tool without one', () => {
    toolAssetsStore.set(readyState([screwdriver]));
    const wall = wallOf();
    const [first, , , unknown] = wall.items;
    if (!first || !unknown) throw new Error('no items');
    const solid = itemSolid(first, wall, new Map(), 'http://localhost/app/');
    expect(solid?.source.kind).toBe('glb');
    if (solid?.source.kind === 'glb') {
      expect(solid.source.url).toBe(`http://localhost/tools/assets/${screwdriver.lod1.path}`);
      expect(solid.source.fallbackBox.max.y).toBeGreaterThan(screwdriver.dimsMm.y / 2);
    }
    expect(solid?.solidKey).toBe(`tool|class:screwdriver|${screwdriver.paramHash}`);
    expect(itemSolid(unknown, wall, new Map(), 'http://localhost/')?.source.kind).toBe('box');
  });
});
