import { describe, expect, test } from 'bun:test';
import {
  cellCenter,
  createEmptyWall,
  DEFAULT_BOARD,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { planMove } from './dragController.ts';

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
