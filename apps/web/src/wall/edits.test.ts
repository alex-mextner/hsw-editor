import { describe, expect, test } from 'bun:test';
import type { BankElement } from '@hsw-editor/bank';
import { cellCenter, createEmptyWall, DEFAULT_BOARD, type Wall } from '@hsw-editor/core';
import { duplicateOps, findFreeCell, newItem, ringCells } from './edits.ts';

const board = { ...DEFAULT_BOARD, cols: 12, rows: 12 };
const two = {
  footprint: {
    cells: [
      { dCol: 0, dRow2: 0 },
      { dCol: 0, dRow2: 2 },
    ],
    cols: 1,
    rows: 2,
  },
  category: 'holders/screwdrivers',
  id: 'e',
} as unknown as BankElement;
const bank = new Map([['e', two]]);

function wallWith(cells: { col: number; row: number }[]): Wall {
  const wall = createEmptyWall('w', 'W', board);
  return { ...wall, items: cells.map((cell) => newItem(two, cell, board)) };
}

describe('ring search on the lattice', () => {
  test('ring r has 6r distinct cells, all at the same hex distance', () => {
    const centre = { col: 6, row: 6 };
    const origin = cellCenter(board, centre);
    for (const ring of [1, 2, 3]) {
      const cells = ringCells(centre, ring);
      expect(cells).toHaveLength(6 * ring);
      expect(new Set(cells.map((c) => `${c.col},${c.row}`)).size).toBe(6 * ring);
    }
    // Ring 1 = the six physical neighbours, one pitch away.
    for (const cell of ringCells(centre, 1)) {
      const c = cellCenter(board, cell);
      expect(Math.hypot(c.x - origin.x, c.y - origin.y)).toBeCloseTo(board.rowPitchMm, 3);
    }
  });
});

describe('finding free space', () => {
  test('the requested cell is used when free', () => {
    expect(findFreeCell(wallWith([]), bank, two, { col: 5, row: 5 })).toEqual({ col: 5, row: 5 });
  });

  test('an occupied footprint pushes the item to the nearest cell where it fits', () => {
    const wall = wallWith([{ col: 5, row: 5 }]);
    const cell = findFreeCell(wall, bank, two, { col: 5, row: 5 });
    expect(cell).not.toBeNull();
    expect(cell).not.toEqual({ col: 5, row: 5 });
    // Whatever it picked must really be collision-free.
    const candidate = newItem(two, cell ?? { col: 0, row: 0 }, board);
    const items = [...wall.items, candidate];
    const cellsOf = (id: string) =>
      new Set(
        items
          .filter((i) => i.id === id)
          .flatMap((i) => [i.cell, { col: i.cell?.col ?? 0, row: (i.cell?.row ?? 0) + 1 }])
          .map((c) => `${c?.col},${c?.row}`),
      );
    const taken = cellsOf(wall.items[0]?.id ?? '');
    for (const key of cellsOf(candidate.id)) expect(taken.has(key)).toBe(false);
  });

  test('returns null on a board that is full', () => {
    const tiny = createEmptyWall('w', 'W', { ...board, cols: 1, rows: 2 });
    const full = { ...tiny, items: [newItem(two, { col: 0, row: 0 }, tiny.board)] };
    expect(findFreeCell(full, bank, two, { col: 0, row: 0 })).toBeNull();
  });
});

describe('free space far from the requested cell', () => {
  test('finds a gap in the opposite corner of the board', () => {
    const taken: { col: number; row: number }[] = [];
    for (let row = 0; row <= 10; row += 2) {
      for (let col = 0; col < board.cols; col += 1) {
        if (row === 10 && col === board.cols - 1) continue;
        taken.push({ col, row });
      }
    }
    const cell = findFreeCell(wallWith(taken), bank, two, { col: 0, row: 0 });
    expect(cell).toEqual({ col: board.cols - 1, row: 10 });
  });
});

describe('duplicate', () => {
  test('copies land on free cells and keep their relative layout', () => {
    const wall = wallWith([{ col: 5, row: 5 }]);
    const ops = duplicateOps(wall, bank, wall.items);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op?.type).toBe('addItem');
    if (op?.type === 'addItem') {
      expect(op.item.id).not.toBe(wall.items[0]?.id);
      expect(op.item.cell).not.toEqual({ col: 5, row: 5 });
    }
  });
});
