import { describe, expect, test } from 'bun:test';
import {
  boardSizeMm,
  cellAtOffset,
  cellCenter,
  cellInBoard,
  DEFAULT_BOARD,
  type Board,
  type CellOffset,
  type GridCell,
} from '@hsw-editor/core';
import {
  cellsExtentMm,
  footprintCells,
  itemCells,
  snapPlacement,
  snapRotation,
  type Occupant,
} from './placement.ts';
import { mulberry32 } from './test-helpers.ts';

const board: Board = DEFAULT_BOARD; // 48 x 32
const size = boardSizeMm(board);

describe('snapPlacement', () => {
  test('snaps to the nearest cell centre and reports the move', () => {
    const c = cellCenter(board, { col: 10, row: 8 });
    const snap = snapPlacement(board, { x: c.x + 3, y: c.y - 4 });
    expect(snap.snapped?.cell).toEqual({ col: 10, row: 8 });
    expect(snap.movedMm).toBeCloseTo(5, 9);
    expect(snap.reason).toEqual({ code: 'nearest-cell' });
  });

  test('a point already on a cell centre is exact', () => {
    const c = cellCenter(board, { col: 3, row: 3 });
    const snap = snapPlacement(board, c);
    expect(snap.reason).toEqual({ code: 'exact' });
    expect(snap.movedMm).toBe(0);
  });

  test('idempotent over random points: the snapped position snaps to itself', () => {
    const random = mulberry32(99);
    for (let i = 0; i < 500; i++) {
      const once = snapPlacement(board, {
        x: random() * size.width * 1.2 - 50,
        y: random() * size.height * 1.2 - 50,
      });
      const twice = snapPlacement(board, { x: once.snapped!.x, y: once.snapped!.y });
      expect(twice.snapped!.cell).toEqual(once.snapped!.cell);
      expect(twice.reason).toEqual({ code: 'exact' });
    }
  });

  test('always the nearest cell by Euclidean distance (brute force check)', () => {
    const random = mulberry32(5);
    for (let i = 0; i < 200; i++) {
      const p = { x: random() * size.width, y: random() * size.height };
      const snap = snapPlacement(board, p);
      let best = Infinity;
      for (let col = 0; col < board.cols; col++) {
        for (let row = 0; row < board.rows; row++) {
          const c = cellCenter(board, { col, row });
          best = Math.min(best, Math.hypot(c.x - p.x, c.y - p.y));
        }
      }
      expect(snap.movedMm).toBeCloseTo(best, 9);
    }
  });

  test('far outside the board clamps to the edge cell and says it kept the item in the board', () => {
    const snap = snapPlacement(board, { x: -500, y: -500 });
    expect(snap.snapped?.cell).toEqual({ col: 0, row: 0 });
    expect(snap.reason).toEqual({ code: 'kept-in-board' });
    expect(cellInBoard(board, snap.snapped!.cell)).toBe(true);
  });

  test('a wide footprint is kept inside the board near the edge', () => {
    // 3 columns wide, anchor in the middle column: anchor col must be in 1..46
    const footprint: CellOffset[] = [
      { dCol: -1, dRow2: -1 },
      { dCol: 0, dRow2: 0 },
      { dCol: 1, dRow2: 1 },
    ];
    const snap = snapPlacement(board, { x: 2, y: 100 }, { footprint });
    expect(snap.snapped!.cell.col).toBe(1);
    expect(snap.reason).toEqual({ code: 'kept-in-board' });
    for (const cell of footprintCells(snap.snapped!.cell, footprint)) {
      expect(cellInBoard(board, cell)).toBe(true);
    }
  });

  test('every snapped footprint cell is inside the board, wherever the pointer is', () => {
    const footprint: CellOffset[] = [
      { dCol: 0, dRow2: -2 },
      { dCol: 0, dRow2: 0 },
      { dCol: 0, dRow2: 2 },
      { dCol: 1, dRow2: 1 },
      { dCol: -1, dRow2: -1 },
    ];
    const random = mulberry32(17);
    for (let i = 0; i < 300; i++) {
      const snap = snapPlacement(
        board,
        { x: random() * size.width * 1.4 - 100, y: random() * size.height * 1.4 - 100 },
        { footprint },
      );
      for (const cell of footprintCells(snap.snapped!.cell, footprint)) {
        expect(cellInBoard(board, cell)).toBe(true);
      }
    }
  });

  test('a footprint bigger than the board has no placement', () => {
    const tiny: Board = { ...board, cols: 2, rows: 2 };
    const footprint: CellOffset[] = [
      { dCol: 0, dRow2: 0 },
      { dCol: 5, dRow2: 1 },
    ];
    const snap = snapPlacement(tiny, { x: 10, y: 10 }, { footprint });
    expect(snap.snapped).toBeNull();
    expect(snap.reason).toEqual({ code: 'footprint-too-large' });
  });

  describe('collisions', () => {
    const other: Occupant = {
      id: 'holder-a',
      cells: [
        { col: 10, row: 8 },
        { col: 11, row: 8 },
      ],
    };

    test('overlapping a neighbour is warned about, not blocked', () => {
      const c = cellCenter(board, { col: 11, row: 8 });
      const snap = snapPlacement(board, c, { occupied: [other] });
      expect(snap.snapped!.cell).toEqual({ col: 11, row: 8 });
      expect(snap.warnings).toEqual([
        { code: 'collision', itemIds: ['holder-a'], cells: [{ col: 11, row: 8 }] },
      ]);
    });

    test('avoidCollisions finds the nearest free cell', () => {
      const c = cellCenter(board, { col: 11, row: 8 });
      const snap = snapPlacement(board, c, { occupied: [other], avoidCollisions: true });
      expect(snap.warnings).toEqual([]);
      expect(snap.reason).toEqual({ code: 'free-cell' });
      const taken = new Set(other.cells.map((cell) => `${cell.col},${cell.row}`));
      expect(taken.has(`${snap.snapped!.cell.col},${snap.snapped!.cell.row}`)).toBe(false);
      // no free cell is strictly nearer
      let best = Infinity;
      for (let col = 0; col < board.cols; col++) {
        for (let row = 0; row < board.rows; row++) {
          if (taken.has(`${col},${row}`)) continue;
          const cc = cellCenter(board, { col, row });
          best = Math.min(best, Math.hypot(cc.x - c.x, cc.y - c.y));
        }
      }
      expect(snap.movedMm).toBeCloseTo(best, 9);
    });

    test('footprint cells are checked, not just the anchor', () => {
      const footprint: CellOffset[] = [
        { dCol: 0, dRow2: 0 },
        { dCol: 1, dRow2: -1 },
      ];
      // anchor (9, 8) is free; its second cell (+1 col, -1 half-row) is (10, 8), which `holder-a` covers
      const c = cellCenter(board, { col: 9, row: 8 });
      const snap = snapPlacement(board, c, { footprint, occupied: [other] });
      expect(snap.warnings[0]?.itemIds).toEqual(['holder-a']);
    });
  });

  describe('ruler guides', () => {
    test('distances to the board edges are in mm and match the extent', () => {
      const snap = snapPlacement(board, cellCenter(board, { col: 0, row: 0 }));
      expect(snap.guides!.edges.left).toBeCloseTo(0, 9);
      expect(snap.guides!.edges.bottom).toBeCloseTo(0, 9);
      expect(snap.guides!.edges.right).toBeCloseTo(size.width - board.colPitchMm, 9);
      expect(snap.guides!.edges.top).toBeCloseTo(size.height - board.rowPitchMm, 9);
    });

    test('nearest neighbour gaps in each direction', () => {
      const left: Occupant = { id: 'L', cells: [{ col: 4, row: 10 }] };
      const right: Occupant = { id: 'R', cells: [{ col: 20, row: 10 }] };
      const above: Occupant = { id: 'A', cells: [{ col: 12, row: 20 }] };
      const snap = snapPlacement(board, cellCenter(board, { col: 12, row: 10 }), {
        occupied: [left, right, above],
      });
      const g = snap.guides!.neighbors;
      expect(g.left?.itemId).toBe('L');
      expect(g.left?.gapMm).toBeCloseTo(7 * board.colPitchMm, 6);
      expect(g.right?.itemId).toBe('R');
      expect(g.right?.gapMm).toBeCloseTo(7 * board.colPitchMm, 6);
      expect(g.above?.itemId).toBe('A');
      expect(g.below).toBeUndefined();
    });

    test('the real extent from the bank bbox replaces the cell extent', () => {
      const snap = snapPlacement(board, cellCenter(board, { col: 12, row: 10 }), {
        extentRelMm: { minX: -50, maxX: 50, minY: -5, maxY: 90 },
      });
      const c = cellCenter(board, { col: 12, row: 10 });
      expect(snap.extentMm).toEqual({
        minX: c.x - 50,
        maxX: c.x + 50,
        minY: c.y - 5,
        maxY: c.y + 90,
      });
    });
  });
});

describe('footprint input validation', () => {
  test('a footprint offset off the honeycomb is bad data and throws, not "too large"', () => {
    expect(() =>
      snapPlacement(board, { x: 50, y: 50 }, { footprint: [{ dCol: 1, dRow2: 0 }] }),
    ).toThrow(RangeError);
  });
});

describe('rotation of the footprint', () => {
  const pair: CellOffset[] = [
    { dCol: 0, dRow2: 0 },
    { dCol: 1, dRow2: 1 },
  ];

  test('a rotated holder is judged on its rotated cells: at 180 degrees it fits against the right edge', () => {
    const rightEdge = cellCenter(board, { col: board.cols - 1, row: 10 });
    const upright = snapPlacement(board, rightEdge, { footprint: pair });
    expect(upright.reason).toEqual({ code: 'kept-in-board' });
    expect(upright.snapped!.cell.col).toBe(board.cols - 2);
    const turned = snapPlacement(board, rightEdge, { footprint: pair, rotZDeg: 180 });
    expect(turned.snapped!.cell).toEqual({ col: board.cols - 1, row: 10 });
    expect(turned.reason).toEqual({ code: 'exact' });
    for (const cell of footprintCells(turned.snapped!.cell, [
      { dCol: 0, dRow2: 0 },
      { dCol: -1, dRow2: -1 },
    ])) {
      expect(cellInBoard(board, cell)).toBe(true);
    }
  });

  test('collisions use the rotated cells', () => {
    const blocker: Occupant = {
      id: 'b',
      cells: [cellAtOffset({ col: 20, row: 10 }, { dCol: -1, dRow2: -1 })],
    };
    const at = cellCenter(board, { col: 20, row: 10 });
    expect(snapPlacement(board, at, { footprint: pair, occupied: [blocker] }).warnings).toEqual([]);
    expect(
      snapPlacement(board, at, { footprint: pair, rotZDeg: 180, occupied: [blocker] }).warnings[0]
        ?.itemIds,
    ).toEqual(['b']);
  });

  test('the bank extent turns with the item', () => {
    const at = cellCenter(board, { col: 20, row: 10 });
    const snap = snapPlacement(board, at, {
      rotZDeg: 180,
      extentRelMm: { minX: -10, maxX: 50, minY: -5, maxY: 8 },
    });
    expect(snap.extentMm!.minX).toBeCloseTo(at.x - 50, 9);
    expect(snap.extentMm!.maxX).toBeCloseTo(at.x + 10, 9);
    expect(snap.extentMm!.minY).toBeCloseTo(at.y - 8, 9);
    expect(snap.extentMm!.maxY).toBeCloseTo(at.y + 5, 9);
  });
});

describe('rotation edge cases', () => {
  const pair: CellOffset[] = [
    { dCol: 0, dRow2: 0 },
    { dCol: 1, dRow2: 1 },
  ];

  test('a bad footprint throws at every rotation, not only at 0 degrees', () => {
    const bad: CellOffset[] = [{ dCol: 1, dRow2: 0 }];
    for (const rotZDeg of [0, 60, 360, 90]) {
      expect(() => snapPlacement(board, { x: 50, y: 50 }, { footprint: bad, rotZDeg })).toThrow(
        RangeError,
      );
    }
    expect(() =>
      snapPlacement(board, { x: 50, y: 50 }, { footprint: pair, rotZDeg: Number.NaN }),
    ).toThrow(RangeError);
  });

  test('itemCells gives both sides of a collision test the same rotated cells', () => {
    const b = itemCells(board, { col: 20, row: 10 }, pair, 180);
    expect(b).toEqual([
      { col: 20, row: 10 },
      cellAtOffset({ col: 20, row: 10 }, { dCol: -1, dRow2: -1 }),
    ]);
    const at = cellCenter(board, b[1]!);
    // dragging an unrotated single cell onto the rotated holder's second cell collides
    const snap = snapPlacement(board, at, { occupied: [{ id: 'B', cells: b }] });
    expect(snap.warnings[0]?.itemIds).toEqual(['B']);
    // the naive (unrotated) cells would have reported a collision on the wrong side instead
    const wrong = footprintCells({ col: 20, row: 10 }, pair);
    expect(wrong).not.toEqual(b);
  });

  test('an off-symmetry rotation is judged at the nearest 60 degree step', () => {
    expect(itemCells(board, { col: 20, row: 10 }, pair, 31)).toEqual(
      itemCells(board, { col: 20, row: 10 }, pair, 60),
    );
  });
});

describe('no placement', () => {
  test('a full board with avoidCollisions says there is no free cell, not that the item is too large', () => {
    const tiny: Board = { ...board, cols: 2, rows: 1 };
    const full: Occupant = {
      id: 'all',
      cells: [
        { col: 0, row: 0 },
        { col: 1, row: 0 },
      ],
    };
    const snap = snapPlacement(tiny, { x: 10, y: 10 }, { occupied: [full], avoidCollisions: true });
    expect(snap.snapped).toBeNull();
    expect(snap.reason).toEqual({ code: 'no-free-cell' });
  });
});

describe('cellsExtentMm', () => {
  test('one cell spans a column pitch by a row pitch around its centre', () => {
    const cell: GridCell = { col: 2, row: 3 };
    const c = cellCenter(board, cell);
    expect(cellsExtentMm(board, [cell])).toEqual({
      minX: c.x - board.colPitchMm / 2,
      maxX: c.x + board.colPitchMm / 2,
      minY: c.y - board.rowPitchMm / 2,
      maxY: c.y + board.rowPitchMm / 2,
    });
  });
});

describe('snapRotation', () => {
  test('rotations go to multiples of 60 degrees', () => {
    expect(snapRotation(29)).toEqual({ requestedDeg: 29, snappedDeg: 0, changed: true });
    expect(snapRotation(31)).toMatchObject({ snappedDeg: 60, changed: true });
    expect(snapRotation(120)).toMatchObject({ snappedDeg: 120, changed: false });
    expect(snapRotation(-60)).toMatchObject({ snappedDeg: 300, changed: false });
    expect(snapRotation(360)).toMatchObject({ snappedDeg: 0, changed: false });
  });
});
