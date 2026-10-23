import { describe, expect, test } from 'bun:test';
import {
  cellCenter,
  createEmptyWall,
  DEFAULT_BOARD,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { freeDropTarget, planMove, resolveDragItems } from './dragController.ts';

const board = { ...DEFAULT_BOARD, cols: 20, rows: 20 };

function holder(id: string, col: number, row: number): WallItem {
  const centre = cellCenter(board, { col, row });
  return {
    id,
    kind: 'holder',
    bankId: 'unknown-element',
    cell: { col, row },
    pose: { x: centre.x, y: centre.y, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

function origins(wall: Wall, ids: string[]) {
  return new Map(
    wall.items
      .filter((item) => ids.includes(item.id))
      .map((item) => [
        item.id,
        { x: item.pose.x, y: item.pose.y, cell: item.cell, rotZ: item.pose.rotZ },
      ]),
  );
}

describe('planMove', () => {
  const wall: Wall = {
    ...createEmptyWall('w', 'W', board),
    items: [holder('a', 4, 4), holder('b', 5, 4), holder('c', 8, 8)],
  };

  test('a snapped drag lands on cell centres', () => {
    const plan = planMove(wall, origins(wall, ['a']), 'a', { x: 37, y: 21 }, true);
    const pose = plan.poses.get('a');
    expect(pose?.cell).toBeDefined();
    if (!pose?.cell) return;
    const centre = cellCenter(board, pose.cell);
    expect(pose.x).toBeCloseTo(centre.x, 9);
    expect(pose.y).toBeCloseTo(centre.y, 9);
  });

  test('a group moves rigidly: neighbouring items keep their relative offset on the lattice', () => {
    const before = {
      dx: wall.items[1]!.pose.x - wall.items[0]!.pose.x,
      dy: wall.items[1]!.pose.y - wall.items[0]!.pose.y,
    };
    for (const delta of [
      { x: 41, y: 17 },
      { x: -63, y: 55 },
      { x: 5, y: -90 },
    ]) {
      const plan = planMove(wall, origins(wall, ['a', 'b']), 'a', delta, true);
      const a = plan.poses.get('a');
      const b = plan.poses.get('b');
      expect(b!.x - a!.x).toBeCloseTo(before.dx, 6);
      expect(b!.y - a!.y).toBeCloseTo(before.dy, 6);
    }
  });

  test('free movement (snap off) applies the exact delta and leaves no cell', () => {
    const plan = planMove(wall, origins(wall, ['a']), 'a', { x: 10.5, y: -3.25 }, false);
    const pose = plan.poses.get('a');
    expect(pose?.cell).toBeUndefined();
    expect(pose?.x).toBeCloseTo(wall.items[0]!.pose.x + 10.5, 9);
    expect(pose?.y).toBeCloseTo(wall.items[0]!.pose.y - 3.25, 9);
  });

  test('dragging beyond the board edge is clamped onto the board by the lattice', () => {
    const plan = planMove(wall, origins(wall, ['c']), 'c', { x: 1e5, y: 1e5 }, true);
    const cell = plan.poses.get('c')?.cell;
    expect(cell?.col).toBe(board.cols - 1);
    expect(cell?.row).toBe(board.rows - 1);
  });
});

function tool(id: string, parentId: string | undefined, x: number, y: number): WallItem {
  return {
    id,
    kind: 'tool',
    toolClass: 'screwdriver',
    modelRefId: 'm',
    ...(parentId === undefined ? {} : { parentId }),
    pose: { x, y, z: 10, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

describe('planMove with hung tools', () => {
  test('a hung tool keeps its offset from the holder when a free tool is pressed', () => {
    const base = holder('h', 6, 6);
    const hung = tool('t', 'h', base.pose.x + 3, base.pose.y + 7);
    const free = tool('f', undefined, 12.3, 45.6);
    const wall: Wall = { ...createEmptyWall('w', 'W', board), items: [base, hung, free] };
    const origin = (item: WallItem, extra: object = {}) =>
      [item.id, { x: item.pose.x, y: item.pose.y, cell: item.cell, rotZ: 0, ...extra }] as const;
    const origins = new Map([
      origin(free),
      origin(base),
      origin(hung, { follows: true, parentId: 'h' }),
    ]);
    for (const delta of [
      { x: 13, y: 9 },
      { x: -21, y: 30 },
      { x: 4, y: -17 },
    ]) {
      const plan = planMove(wall, origins, 'f', delta, true);
      const h = plan.poses.get('h');
      const t = plan.poses.get('t');
      expect(t!.x - h!.x).toBeCloseTo(3, 9);
      expect(t!.y - h!.y).toBeCloseTo(7, 9);
    }
  });
});

describe('resolveDragItems', () => {
  const h = holder('h', 6, 6);
  const wall: Wall = {
    ...createEmptyWall('w', 'W', board),
    items: [
      h,
      tool('t', 'h', h.pose.x, h.pose.y),
      { ...tool('locked', 'h', h.pose.x, h.pose.y), locked: true },
      tool('f', undefined, 5, 5),
    ],
  };

  test('a selected tool on a selected holder rides along, locked hung tools are carried too', () => {
    const r = resolveDragItems(wall, ['h', 't', 'f'], 'h');
    expect(r.movable.map((i) => i.id)).toEqual(['h', 'f']);
    expect(r.carried.map((i) => i.id)).toEqual(['t', 'locked']);
    expect(r.primaryId).toBe('h');
  });

  test('pressing a hung tool of a selected holder drags the holder', () => {
    const r = resolveDragItems(wall, ['h', 't'], 't');
    expect(r.primaryId).toBe('h');
  });

  test('a lone selected tool is its own primary and carries nothing', () => {
    const r = resolveDragItems(wall, ['f'], 'f');
    expect(r.primaryId).toBe('f');
    expect(r.carried).toEqual([]);
  });

  test('pressing an unselected or locked item leads nothing', () => {
    expect(resolveDragItems(wall, ['f'], 'h').primaryId).toBeNull();
    expect(resolveDragItems(wall, ['locked'], 'locked').primaryId).toBeNull();
  });
});

describe('freeDropTarget', () => {
  const pose = { x: 37.3, y: 21.1 };

  test('snap on lands on a cell', () => {
    expect(freeDropTarget(board, pose, true, false)).toHaveProperty('cell');
  });

  test('Alt with snap on lands exactly under the pointer', () => {
    expect(freeDropTarget(board, pose, true, true)).toEqual(pose);
  });

  test('snap off stays free, and Alt with snap off must not snap to a cell', () => {
    expect(freeDropTarget(board, pose, false, false)).toEqual(pose);
    expect(freeDropTarget(board, pose, false, true)).toEqual(pose);
  });
});
