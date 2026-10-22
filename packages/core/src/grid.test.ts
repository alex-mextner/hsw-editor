import { describe, expect, test } from 'bun:test';
import {
  cellAtOffset,
  cellCenter,
  DEFAULT_BOARD,
  rotateCellOffset,
  type CellOffset,
  type GridCell,
} from './grid.ts';

const board = DEFAULT_BOARD;

describe('cellAtOffset', () => {
  test('a +1 column, +1 half-row step reaches the neighbour above-right from either column parity', () => {
    expect(cellAtOffset({ col: 4, row: 5 }, { dCol: 1, dRow2: 1 })).toEqual({ col: 5, row: 5 });
    expect(cellAtOffset({ col: 5, row: 5 }, { dCol: 1, dRow2: 1 })).toEqual({ col: 6, row: 6 });
  });

  test('reproduces the mm offset (dCol * colPitch, dRow2 * rowPitch / 2) from any anchor', () => {
    const anchors: GridCell[] = [
      { col: 4, row: 5 },
      { col: 5, row: 5 },
      { col: 11, row: 20 },
      { col: 0, row: 0 },
    ];
    const offsets: CellOffset[] = [
      { dCol: 0, dRow2: 2 },
      { dCol: 1, dRow2: -1 },
      { dCol: -2, dRow2: 0 },
      { dCol: 3, dRow2: 3 },
      { dCol: -1, dRow2: -3 },
    ];
    for (const anchor of anchors) {
      for (const offset of offsets) {
        const a = cellCenter(board, anchor);
        const b = cellCenter(board, cellAtOffset(anchor, offset));
        expect(b.x - a.x).toBeCloseTo(offset.dCol * board.colPitchMm, 9);
        expect(b.y - a.y).toBeCloseTo((offset.dRow2 * board.rowPitchMm) / 2, 9);
      }
    }
  });

  test('an offset off the honeycomb is bad data and throws', () => {
    expect(() => cellAtOffset({ col: 4, row: 4 }, { dCol: 1, dRow2: 0 })).toThrow(RangeError);
    expect(() => cellAtOffset({ col: 4, row: 4 }, { dCol: 0.5, dRow2: 0.5 })).toThrow(RangeError);
    expect(() => cellAtOffset({ col: 4, row: 4 }, { dCol: -1, dRow2: 0 })).toThrow(RangeError);
  });
});

describe('rotateCellOffset', () => {
  test('multiples of 60 degrees map lattice offsets onto lattice offsets, and 360 is the identity', () => {
    const offsets: CellOffset[] = [
      { dCol: 1, dRow2: 1 },
      { dCol: 0, dRow2: 2 },
      { dCol: 2, dRow2: 0 },
      { dCol: -1, dRow2: 3 },
    ];
    for (const offset of offsets) {
      for (let k = 0; k < 6; k++) {
        const r = rotateCellOffset(board, offset, 60 * k);
        expect(Math.abs(r.dRow2 - r.dCol) % 2).toBe(0);
        // rotation preserves the distance from the anchor
        const d0 = Math.hypot(
          offset.dCol * board.colPitchMm,
          (offset.dRow2 * board.rowPitchMm) / 2,
        );
        const d1 = Math.hypot(r.dCol * board.colPitchMm, (r.dRow2 * board.rowPitchMm) / 2);
        expect(d1).toBeCloseTo(d0, 3);
      }
      expect(rotateCellOffset(board, offset, 360)).toEqual(offset);
      expect(rotateCellOffset(board, rotateCellOffset(board, offset, 60), -60)).toEqual(offset);
    }
  });

  test('180 degrees negates the offset', () => {
    expect(rotateCellOffset(board, { dCol: 1, dRow2: 1 }, 180)).toEqual({ dCol: -1, dRow2: -1 });
  });

  test('an arbitrary angle yields the nearest lattice offset (brute-force check)', () => {
    const offsets: CellOffset[] = [
      { dCol: 2, dRow2: 2 },
      { dCol: 3, dRow2: 1 },
      { dCol: 0, dRow2: 4 },
    ];
    for (const offset of offsets) {
      for (let deg = 0; deg < 360; deg += 7) {
        const t = (deg * Math.PI) / 180;
        const x = offset.dCol * board.colPitchMm;
        const y = (offset.dRow2 * board.rowPitchMm) / 2;
        const tx = x * Math.cos(t) - y * Math.sin(t);
        const ty = x * Math.sin(t) + y * Math.cos(t);
        let best = Infinity;
        for (let dCol = -8; dCol <= 8; dCol++) {
          for (let dRow2 = -12; dRow2 <= 12; dRow2++) {
            if (Math.abs(dRow2 - dCol) % 2 !== 0) continue;
            best = Math.min(
              best,
              Math.hypot(dCol * board.colPitchMm - tx, (dRow2 * board.rowPitchMm) / 2 - ty),
            );
          }
        }
        const r = rotateCellOffset(board, offset, deg);
        const got = Math.hypot(
          r.dCol * board.colPitchMm - tx,
          (r.dRow2 * board.rowPitchMm) / 2 - ty,
        );
        expect(got).toBeLessThanOrEqual(best + 1e-6);
      }
    }
  });

  test('an arbitrary angle still yields a valid lattice offset', () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const r = rotateCellOffset(board, { dCol: 2, dRow2: 2 }, deg);
      expect(Math.abs(r.dRow2 - r.dCol) % 2).toBe(0);
    }
  });
});
