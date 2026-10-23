import { describe, expect, test } from 'bun:test';
import {
  boardExtent,
  calibrateFromCorners,
  calibrateTwoPoint,
  photoMapFromCalibration,
  toCoreCalibration,
} from '@hsw-editor/overlay';
import { DEFAULT_BOARD } from '@hsw-editor/core';
import { alignCalibration, snapToLattice, withHomography } from './photoAlign.ts';

const image = { width: 1400, height: 1000 };
const extent = boardExtent(DEFAULT_BOARD);

const twoPoint = toCoreCalibration(
  calibrateTwoPoint({ a: [100, 800], b: [900, 800], realMm: 1000 }, image, extent),
);
const corners = toCoreCalibration(
  calibrateFromCorners(
    {
      cornersPx: [
        [210, 800],
        [1130, 770],
        [1085, 160],
        [250, 190],
      ],
      widthMm: extent.widthMm,
      heightMm: extent.heightMm,
    },
    image,
  ),
);

/** Where a board point appears in the photo under a calibration. */
function appears(calibration: typeof twoPoint, board: [number, number]): [number, number] {
  const map = photoMapFromCalibration(calibration, image, extent);
  const px = map?.wallToPx(board);
  if (!px) throw new Error('not visible');
  return [px[0], px[1]];
}

describe('alignCalibration', () => {
  for (const [name, base] of [
    ['two-point', twoPoint],
    ['four corners (perspective)', corners],
  ] as const) {
    test(`move: the grabbed board point follows the pointer (${name})`, () => {
      const map = photoMapFromCalibration(base, image, extent);
      const grab: [number, number] = [600, 500];
      const board = map?.pxToWall(grab);
      if (!board) throw new Error('no map');
      const moved = alignCalibration(base, image, extent, {
        kind: 'move',
        startPx: grab,
        nowPx: [650, 470],
      });
      expect(moved).not.toBeNull();
      const now = appears(moved ?? base, [board[0], board[1]]);
      expect(now[0]).toBeCloseTo(650, 6);
      expect(now[1]).toBeCloseTo(470, 6);
    });

    test(`roll: the grabbed board point follows the pointer around the board centre (${name})`, () => {
      const map = photoMapFromCalibration(base, image, extent);
      const centre: [number, number] = [extent.widthMm / 2, extent.heightMm / 2];
      const centrePx = appears(base, centre);
      const grab: [number, number] = [centrePx[0] + 200, centrePx[1] + 30];
      const board = map?.pxToWall(grab);
      if (!board) throw new Error('no map');
      // The pointer goes to where the board point would be after turning the board 12 degrees about its centre.
      const turn = (12 * Math.PI) / 180;
      const dx = board[0] - centre[0];
      const dy = board[1] - centre[1];
      const target: [number, number] = [
        centre[0] + dx * Math.cos(turn) - dy * Math.sin(turn),
        centre[1] + dx * Math.sin(turn) + dy * Math.cos(turn),
      ];
      const nowPx = map?.wallToPx(target);
      if (!nowPx) throw new Error('target off the plane');
      const rolled = alignCalibration(base, image, extent, {
        kind: 'roll',
        startPx: grab,
        nowPx: [nowPx[0], nowPx[1]],
      });
      expect(rolled).not.toBeNull();
      const after = appears(rolled ?? base, [board[0], board[1]]);
      expect(after[0]).toBeCloseTo(nowPx[0], 6);
      expect(after[1]).toBeCloseTo(nowPx[1], 6);
      const centreAfter = appears(rolled ?? base, centre);
      expect(centreAfter[0]).toBeCloseTo(centrePx[0], 6);
      expect(centreAfter[1]).toBeCloseTo(centrePx[1], 6);
    });
  }

  test('the scale and the fit error survive an alignment', () => {
    const moved = alignCalibration(twoPoint, image, extent, {
      kind: 'move',
      startPx: [300, 300],
      nowPx: [340, 280],
    });
    expect(moved?.mmPerPx).toBe(twoPoint.mmPerPx);
    expect(moved?.method).toBe('two-point');
  });

  test('a calibration that is only a scale gets a homography to edit', () => {
    const scaleOnly = { method: 'vision' as const, mmPerPx: 1.5 };
    const map = photoMapFromCalibration(scaleOnly, image, extent);
    if (!map) throw new Error('no map');
    expect(withHomography(scaleOnly, map).homography).toBeDefined();
    const moved = alignCalibration(scaleOnly, image, extent, {
      kind: 'move',
      startPx: [300, 300],
      nowPx: [310, 300],
    });
    expect(moved?.homography).toBeDefined();
  });
});

describe('snapToLattice', () => {
  const lattice = { colPitchMm: 20, rowPitchMm: 24 };

  test('a shift along a column is a whole number of rows, and along x a whole number of columns', () => {
    expect(snapToLattice(0.4, 49, lattice)).toEqual({ dxMm: 0, dyMm: 48 });
    expect(snapToLattice(41, 1, lattice)).toEqual({ dxMm: 40, dyMm: 0 });
  });

  test('a one-column shift carries the half-row stagger', () => {
    // Plain rounding would give (20, 0) - a spot between real cells.
    expect(snapToLattice(20, 0, lattice).dxMm).toBe(20);
    expect(Math.abs(snapToLattice(20, 0, lattice).dyMm)).toBe(12);
    expect(snapToLattice(21, 4, lattice).dyMm % 24).not.toBe(0);
  });

  test('negative shifts snap the same way', () => {
    expect(snapToLattice(-41, -49, lattice)).toEqual({ dxMm: -40, dyMm: -48 });
    expect(snapToLattice(-20, 0, lattice).dxMm).toBe(-20);
    expect(Math.abs(snapToLattice(-20, 0, lattice).dyMm)).toBe(12);
  });

  test('every result is a lattice translation', () => {
    for (let i = 0; i < 200; i += 1) {
      const dx = Math.sin(i * 12.9898) * 400;
      const dy = Math.cos(i * 78.233) * 400;
      const snapped = snapToLattice(dx, dy, lattice);
      const col = snapped.dxMm / 20;
      const row2 = snapped.dyMm / 12;
      expect(Number.isInteger(col)).toBe(true);
      expect(Number.isInteger(row2)).toBe(true);
      expect(Math.abs(col - row2) % 2).toBe(0);
    }
  });
});

describe('alignCalibration on a grid calibration', () => {
  test('a move shifts the board by a lattice translation when the lattice is given', () => {
    const lattice = { colPitchMm: DEFAULT_BOARD.colPitchMm, rowPitchMm: DEFAULT_BOARD.rowPitchMm };
    const gesture = { kind: 'move', startPx: [600, 500], nowPx: [650, 470] } as const;
    const moved = alignCalibration(corners, image, extent, gesture, lattice);
    const free = alignCalibration(corners, image, extent, gesture);
    if (!moved || !free) throw new Error('no calibration');
    const before = photoMapFromCalibration(corners, image, extent);
    const after = photoMapFromCalibration(moved, image, extent);
    if (!before || !after) throw new Error('no map');
    // A wall-frame shift adds the same translation to every photo pixel's wall point.
    const a = before.pxToWall([700, 400]);
    const b = after.pxToWall([700, 400]);
    if (!a || !b) throw new Error('no wall point');
    const cols = (b[0] - a[0]) / lattice.colPitchMm;
    const rows2 = (b[1] - a[1]) / (lattice.rowPitchMm / 2);
    expect(cols).toBeCloseTo(Math.round(cols), 6);
    expect(rows2).toBeCloseTo(Math.round(rows2), 6);
    expect(Math.abs(Math.round(cols) - Math.round(rows2)) % 2).toBe(0);
    expect(free.homography).not.toEqual(moved.homography);
  });
});
