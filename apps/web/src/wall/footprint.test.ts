import { describe, expect, test } from 'bun:test';
import type { BankElement } from '@hsw-editor/bank';
import { DEFAULT_BOARD, type WallItem } from '@hsw-editor/core';
import { footprintCells, layoutProblems, offsetCell, rotateOffset } from './footprint.ts';

const board = { ...DEFAULT_BOARD, cols: 10, rows: 10 };

function element(cells: { dCol: number; dRow2: number }[]): BankElement {
  // Only the footprint matters for layout checks; the rest of the record is irrelevant here.
  return { footprint: { cells, cols: 1, rows: 1 } } as unknown as BankElement;
}

function placed(id: string, col: number, row: number, rotZ = 0): WallItem {
  return {
    id,
    kind: 'holder',
    bankId: 'e',
    cell: { col, row },
    pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

describe('cell offsets on the staggered lattice', () => {
  test('neighbour offsets are the six lattice neighbours, independent of column parity', () => {
    const neighbours = [
      { dCol: 0, dRow2: 2 },
      { dCol: 0, dRow2: -2 },
      { dCol: 1, dRow2: 1 },
      { dCol: 1, dRow2: -1 },
      { dCol: -1, dRow2: 1 },
      { dCol: -1, dRow2: -1 },
    ];
    for (const anchor of [
      { col: 4, row: 4 },
      { col: 5, row: 4 },
    ]) {
      const cells = neighbours.map((offset) => offsetCell(anchor, offset));
      expect(new Set(cells.map((c) => `${c.col},${c.row}`)).size).toBe(6);
    }
    // Even column: up-right neighbour keeps the row; odd column: it moves up one row.
    expect(offsetCell({ col: 4, row: 4 }, { dCol: 1, dRow2: 1 })).toEqual({ col: 5, row: 4 });
    expect(offsetCell({ col: 5, row: 4 }, { dCol: 1, dRow2: 1 })).toEqual({ col: 6, row: 5 });
  });

  test('six 60 degree rotations return every offset to itself and map neighbours to neighbours', () => {
    const offset = { dCol: 2, dRow2: 0 };
    let current = offset;
    for (let step = 0; step < 6; step += 1) {
      current = rotateOffset(current, 60, board);
      expect(Math.abs(current.dRow2 - current.dCol) % 2).toBe(0);
    }
    expect(current).toEqual(offset);
    expect(rotateOffset({ dCol: 0, dRow2: 2 }, 60, board)).toEqual({ dCol: -1, dRow2: 1 });
  });

  test('footprint cells follow the rotation', () => {
    const el = element([
      { dCol: 0, dRow2: 0 },
      { dCol: 0, dRow2: 2 },
    ]);
    const upright = footprintCells(el, { col: 4, row: 4 }, 0, board);
    const turned = footprintCells(el, { col: 4, row: 4 }, 60, board);
    expect(upright[1]).toEqual({ col: 4, row: 5 });
    expect(turned[1]).not.toEqual(upright[1]);
  });
});

describe('layoutProblems', () => {
  const bank = new Map([
    [
      'e',
      element([
        { dCol: 0, dRow2: 0 },
        { dCol: 0, dRow2: 2 },
      ]),
    ],
  ]);

  test('overlapping footprints collide even when anchors differ', () => {
    const problems = layoutProblems([placed('a', 3, 3), placed('b', 3, 4)], board, bank);
    expect(problems.get('a')).toBe('collision');
    expect(problems.get('b')).toBe('collision');
  });

  test('disjoint items are clean and a footprint hanging off the board is out of bounds', () => {
    const clean = layoutProblems([placed('a', 1, 1), placed('b', 5, 5)], board, bank);
    expect(clean.size).toBe(0);
    const off = layoutProblems([placed('top', 4, 9)], board, bank);
    expect(off.get('top')).toBe('bounds');
  });
});
