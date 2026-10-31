import { describe, expect, test } from 'bun:test';
import {
  checkWall,
  createEmptyWall,
  DEFAULT_BOARD,
  FLOOR_Y_MM,
  type Wall,
  type WallItem,
  withoutFloorWarnings,
} from '@hsw-editor/core';
import { toolLiesOnFloor, withFloor } from './floorItems.ts';

const board = { ...DEFAULT_BOARD, cols: 30, rows: 30 };

function tool(id: string, y: number, parentId?: string): WallItem {
  return {
    id,
    kind: 'tool',
    modelRefId: 'm',
    toolClass: 'screwdriver',
    label: id,
    ...(parentId === undefined ? {} : { parentId }),
    pose: { x: 300, y, z: 20, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

const wallWith = (...items: WallItem[]): Wall => ({
  ...createEmptyWall('w', 'W', board),
  items,
  models: [
    {
      id: 'm',
      label: 'driver',
      status: 'chosen',
      source: { type: 'library', by: 'preset' },
      dimensionsMm: { x: 28, y: 210, z: 28 },
      toolClass: 'screwdriver',
    },
  ],
});

describe('toolLiesOnFloor', () => {
  test('a tool whose lowest point is on the floor lies on it; one hanging above does not', () => {
    // the box of an upright preset tool starts at its origin
    expect(toolLiesOnFloor(wallWith(tool('fallen', FLOOR_Y_MM)), new Map())).toBe(true);
    expect(toolLiesOnFloor(wallWith(tool('hung', 300)), new Map())).toBe(false);
  });

  test('a tool that hangs on a holder is never on the floor, and an empty wall has no fallen tool', () => {
    expect(toolLiesOnFloor(wallWith(tool('t', FLOOR_Y_MM, 'h')), new Map())).toBe(false);
    expect(toolLiesOnFloor(wallWith(), new Map())).toBe(false);
  });
});

describe('withFloor', () => {
  test('the framed extent reaches down to the floor and keeps the rest', () => {
    expect(withFloor({ x0: 0, y0: 0, x1: 981, y1: 767 })).toEqual({
      x0: 0,
      y0: FLOOR_Y_MM,
      x1: 981,
      y1: 767,
    });
  });

  test('a fallen tool further down (overhang) is not cut off', () => {
    expect(withFloor({ x0: 0, y0: -400, x1: 981, y1: 767 }).y0).toBe(-400);
  });
});

describe('layout warnings of a fallen tool', () => {
  test('a tool lying on the floor is not "outside the board"; one far below it still is', () => {
    const wall: Wall = {
      ...createEmptyWall('w', 'W', board),
      items: [tool('lying', FLOOR_Y_MM + 5), tool('lost', -900)],
    };
    const ids = withoutFloorWarnings(wall, checkWall(wall))
      .filter((w) => w.code === 'out_of_board')
      .flatMap((w) => w.itemIds);
    expect(ids).toEqual(['lost']);
  });
});
