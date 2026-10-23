import { describe, expect, test } from 'bun:test';
import type { BankElement } from '@hsw-editor/bank';
import { boardSizeMm, createEmptyWall, type Wall, type WallItem } from '@hsw-editor/core';
import { dragGuides } from './photoGuides.ts';

const element = {
  id: 'h1',
  footprint: { cells: [{ dCol: 0, dRow2: 0 }] },
} as unknown as BankElement;
const bank = new Map([['h1', element]]);

function holder(id: string, col: number, row: number, x: number, y: number): WallItem {
  return {
    id,
    kind: 'holder',
    bankId: 'h1',
    cell: { col, row },
    pose: { x, y, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  } as WallItem;
}

describe('dragGuides', () => {
  const base = createEmptyWall('w', 'W');
  const size = boardSizeMm(base.board);
  const wall: Wall = {
    ...base,
    items: [
      holder('a', 10, 10, 20.4382 * 10.5, 23.6 * 10.5),
      holder('b', 20, 10, 20.4382 * 20.5, 23.6 * 10.5),
    ],
  };

  test('reports mm to the board edges and to the neighbour that shares its rows', () => {
    const dragging = new Map([['a', { x: 20.4382 * 10.5, y: 23.6 * 10.5, rotZ: 0 }]]);
    const result = dragGuides(wall, bank, dragging, 'a');
    if (!result) throw new Error('no guides');
    const edge = result.segments.filter((s) => s.kind === 'edge').map((s) => s.gapMm);
    expect(edge).toHaveLength(4);
    expect(edge[0]).toBeCloseTo(result.extent.minX, 6);
    expect(edge[1]).toBeCloseTo(size.width - result.extent.maxX, 6);
    const right = result.segments.find((s) => s.kind === 'neighbor');
    expect(right?.gapMm).toBeGreaterThan(0);
    // The neighbour is to the right: its segment starts at the dragged extent and ends further right.
    expect(right?.to[0]).toBeGreaterThan(right?.from[0] ?? 0);
  });

  test('nothing is dragged, nothing to show; an element missing from the bank shows nothing either', () => {
    expect(dragGuides(wall, bank, new Map(), undefined)).toBeNull();
    const dragging = new Map([['a', { x: 100, y: 100, rotZ: 0 }]]);
    expect(dragGuides(wall, new Map(), dragging, 'a')).toBeNull();
  });
});
