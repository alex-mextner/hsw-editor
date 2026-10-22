import { describe, expect, test } from 'bun:test';
import {
  CalibrationSchema,
  cellCenter,
  DEFAULT_BOARD,
  MAX_CALIBRATION_POINTS,
} from '@hsw-editor/core';
import {
  boardExtent,
  calibrateFromCorners,
  calibrateFromCorrespondences,
  calibrateTwoPoint,
  cellCorrespondences,
  CornerOrderError,
  DEFAULT_REFERENCE_MM,
  photoMapFromCalibration,
  referenceLengthPx,
  scaleErrorBound,
  scaleFromReference,
  toCoreCalibration,
  transformCalibration,
} from './calibration.ts';
import { homographyFromCamera } from './camera.ts';
import { project } from './homography.ts';
import { DegenerateError, inv3, type Vec2 } from './matrix.ts';
import { createPhotoMap, scaleSpread } from './photo-map.ts';
import {
  gaussian,
  IMG_4937_SIZE,
  img4937Camera,
  mulberry32,
  syntheticCamera,
  wallToPhoto,
} from './test-helpers.ts';

const EXTENT = boardExtent(DEFAULT_BOARD);

describe('two-point scale', () => {
  const image = { width: 1000, height: 800 };

  test('mm per px is the typed length over the clicked pixel distance', () => {
    const m = { a: [100, 100] as Vec2, b: [400, 500] as Vec2, realMm: DEFAULT_REFERENCE_MM };
    expect(referenceLengthPx(m)).toBeCloseTo(500, 12);
    expect(scaleFromReference(m)).toBeCloseTo(2, 12);
  });

  test('the calibrated wall frame reproduces the typed length between the clicks, at any orientation', () => {
    for (const angle of [0, 33, 90, 135, 200, 271]) {
      const t = (angle * Math.PI) / 180;
      const a: Vec2 = [300, 400];
      const b: Vec2 = [300 + 250 * Math.cos(t), 400 - 250 * Math.sin(t)];
      for (const axis of ['free', 'horizontal', 'vertical'] as const) {
        const result = calibrateTwoPoint({ a, b, realMm: 640, axis }, image, EXTENT);
        const wa = project(result.homography, a)!;
        const wb = project(result.homography, b)!;
        expect(Math.hypot(wb[0] - wa[0], wb[1] - wa[1])).toBeCloseTo(640, 9);
        if (axis === 'horizontal') expect(Math.abs(wb[1] - wa[1])).toBeLessThan(1e-9);
        if (axis === 'vertical') expect(Math.abs(wb[0] - wa[0])).toBeLessThan(1e-9);
      }
    }
  });

  test('the board sits centred under the photo centre and y points up', () => {
    const result = calibrateTwoPoint({ a: [0, 0], b: [500, 0], realMm: 1000 }, image, EXTENT);
    const centre = project(result.homography, [500, 400])!;
    expect(centre[0]).toBeCloseTo(EXTENT.widthMm / 2, 9);
    expect(centre[1]).toBeCloseTo(EXTENT.heightMm / 2, 9);
    const up = project(result.homography, [500, 300])!;
    expect(up[1]).toBeGreaterThan(centre[1]);
  });

  test('coincident clicks and non-positive lengths are rejected', () => {
    expect(() => scaleFromReference({ a: [10, 10], b: [11, 10], realMm: 1000 })).toThrow(
      DegenerateError,
    );
    expect(() => scaleFromReference({ a: [10, 10], b: [500, 10], realMm: 0 })).toThrow(
      DegenerateError,
    );
    expect(() => scaleFromReference({ a: [10, 10], b: [500, 10], realMm: Number.NaN })).toThrow(
      DegenerateError,
    );
  });

  test('click error bound: 3 px per click on a 1 m tape that spans 1000 px', () => {
    const m = { a: [100, 400] as Vec2, b: [1100, 400] as Vec2, realMm: 1000 };
    const bound = scaleErrorBound(m, 3);
    expect(bound.worstRelativeError).toBeCloseTo(1000 / 994 - 1, 12);
    expect(bound.worstMmPerMeter).toBeCloseTo(6.036, 2);
    expect(bound.typicalRelativeError).toBeCloseTo((Math.SQRT2 * 3) / 1000, 12);
    // Brute force: every pair of 3 px offsets (16 directions each) stays inside the bound, the worst one touches it.
    let worst = 0;
    const exact = scaleFromReference(m);
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 16; j++) {
        const ti = (i / 16) * 2 * Math.PI;
        const tj = (j / 16) * 2 * Math.PI;
        const a: Vec2 = [m.a[0] + 3 * Math.cos(ti), m.a[1] + 3 * Math.sin(ti)];
        const b: Vec2 = [m.b[0] + 3 * Math.cos(tj), m.b[1] + 3 * Math.sin(tj)];
        worst = Math.max(worst, Math.abs(scaleFromReference({ a, b, realMm: 1000 }) / exact - 1));
      }
    }
    expect(worst).toBeLessThanOrEqual(bound.worstRelativeError * (1 + 1e-9));
    expect(worst).toBeGreaterThan(bound.worstRelativeError * (1 - 1e-9));
  });

  test('a short tape on a big photo is flagged by a large error bound', () => {
    const long = scaleErrorBound({ a: [0, 0], b: [1000, 0], realMm: 1000 }, 3);
    const short = scaleErrorBound({ a: [0, 0], b: [100, 0], realMm: 100 }, 3);
    expect(short.worstRelativeError).toBeGreaterThan(long.worstRelativeError * 9);
  });
});

describe('four-corner rectification', () => {
  const image = { width: 1200, height: 1600 };
  const camera = syntheticCamera({
    image,
    focalPx: 1100,
    yawDeg: 25,
    pitchDeg: 18,
    rollDeg: 4,
    distanceMm: 2200,
    lookAt: [600, 500],
  });
  const wallCorners: Vec2[] = [
    [0, 0],
    [1200, 0],
    [1200, 1000],
    [0, 1000],
  ];
  const cornersPx = wallCorners.map((w) => wallToPhoto(camera, w)) as [Vec2, Vec2, Vec2, Vec2];

  test('recovers the metric wall plane of a tilted photo to sub-mm, with zero reprojection error', () => {
    const result = calibrateFromCorners({ cornersPx, widthMm: 1200, heightMm: 1000 }, image);
    let worst = 0;
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const wall: Vec2 = [(i * 1200) / 8, (j * 1000) / 8];
        const back = project(result.homography, wallToPhoto(camera, wall))!;
        worst = Math.max(worst, Math.hypot(back[0] - wall[0], back[1] - wall[1]));
      }
    }
    expect(worst).toBeLessThan(1e-6);
    expect(result.reprojection.maxPx).toBeLessThan(1e-6);
    expect(result.method).toBe('manual');
    // tilt is large enough to also recover the focal length
    expect(result.focalPx).toBeDefined();
    expect(Math.abs(result.focalPx! - 1100)).toBeLessThan(1e-3);
  });

  test('half-pixel click noise keeps the wall within a few mm', () => {
    const random = mulberry32(11);
    const noisy = cornersPx.map(
      (p) => [p[0] + 0.5 * gaussian(random), p[1] + 0.5 * gaussian(random)] as Vec2,
    ) as [Vec2, Vec2, Vec2, Vec2];
    const result = calibrateFromCorners({ cornersPx: noisy, widthMm: 1200, heightMm: 1000 }, image);
    let worst = 0;
    for (const wall of [
      [600, 500],
      [100, 100],
      [1100, 900],
      [100, 900],
      [1100, 100],
    ] as Vec2[]) {
      const back = project(result.homography, wallToPhoto(camera, wall))!;
      worst = Math.max(worst, Math.hypot(back[0] - wall[0], back[1] - wall[1]));
    }
    expect(worst).toBeLessThan(6);
  });

  test('starting at the wrong corner is reported, not fitted (it would silently turn the wall by 90 degrees)', () => {
    const [bl, br, tr, tl] = cornersPx;
    const startAtUpperLeft: [Vec2, Vec2, Vec2, Vec2] = [tl, bl, br, tr];
    const startAtUpperRight: [Vec2, Vec2, Vec2, Vec2] = [tr, tl, bl, br];
    for (const order of [startAtUpperLeft, startAtUpperRight]) {
      expect(() =>
        calibrateFromCorners({ cornersPx: order, widthMm: 1200, heightMm: 1000 }, image),
      ).toThrow(CornerOrderError);
    }
  });

  test('a rolled photo (30 degrees) is still accepted', () => {
    const rolled = syntheticCamera({
      image,
      focalPx: 1100,
      yawDeg: 10,
      pitchDeg: 8,
      rollDeg: 30,
      distanceMm: 2200,
      lookAt: [600, 500],
    });
    const px = wallCorners.map((w) => wallToPhoto(rolled, w)) as [Vec2, Vec2, Vec2, Vec2];
    expect(
      calibrateFromCorners({ cornersPx: px, widthMm: 1200, heightMm: 1000 }, image).method,
    ).toBe('manual');
  });

  test('wrong click order is reported, not fitted', () => {
    const [bl, br, tr, tl] = cornersPx;
    // swapped pair -> bow-tie
    expect(() =>
      calibrateFromCorners({ cornersPx: [bl, tr, br, tl], widthMm: 1200, heightMm: 1000 }, image),
    ).toThrow(CornerOrderError);
    // counter-clockwise on screen = mirrored plane
    expect(() =>
      calibrateFromCorners({ cornersPx: [bl, tl, tr, br], widthMm: 1200, heightMm: 1000 }, image),
    ).toThrow(CornerOrderError);
  });
});

describe('moving the board under a two-point calibration', () => {
  const image = { width: 1000, height: 800 };

  test('a shift moves the wall frame, keeps scale and error, and carries the stored points along', () => {
    const stored = toCoreCalibration(
      calibrateTwoPoint({ a: [100, 100], b: [600, 100], realMm: 1000 }, image, EXTENT),
    );
    const moved = transformCalibration(stored, { dxMm: 100, dyMm: -40 })!;
    expect(CalibrationSchema.safeParse(moved).success).toBe(true);
    expect(moved.mmPerPx).toBe(stored.mmPerPx!);
    expect(moved.reprojErrorPx).toBe(stored.reprojErrorPx!);
    const before = photoMapFromCalibration(stored, image, EXTENT)!;
    const after = photoMapFromCalibration(moved, image, EXTENT)!;
    const a = before.pxToWall([300, 300])!;
    const b = after.pxToWall([300, 300])!;
    expect(b[0] - a[0]).toBeCloseTo(100, 9);
    expect(b[1] - a[1]).toBeCloseTo(-40, 9);
    // the stored correspondences still describe the same clicks under the new frame
    for (const point of moved.points!) {
      const w = after.pxToWall(point.px)!;
      expect(Math.hypot(w[0] - point.wall[0], w[1] - point.wall[1])).toBeLessThan(1e-9);
    }
  });

  test('a roll keeps the typed reference length between the stored points', () => {
    const stored = toCoreCalibration(
      calibrateTwoPoint({ a: [100, 100], b: [600, 100], realMm: 1000 }, image, EXTENT),
    );
    const rolled = transformCalibration(stored, { rollDeg: 12, about: [0, 0] })!;
    const [p, q] = rolled.points!;
    expect(Math.hypot(q!.wall[0] - p!.wall[0], q!.wall[1] - p!.wall[1])).toBeCloseTo(1000, 9);
  });

  test('a calibration without a homography cannot be edited', () => {
    expect(transformCalibration({ method: 'vision', mmPerPx: 1 }, { dxMm: 5 })).toBeNull();
  });
});

describe('stored calibration', () => {
  const image = { width: 1000, height: 800 };

  test('toCoreCalibration validates against the core schema and rebuilds the same map', () => {
    const result = calibrateTwoPoint({ a: [100, 100], b: [600, 100], realMm: 1000 }, image, EXTENT);
    const stored = toCoreCalibration(result);
    expect(CalibrationSchema.safeParse(stored).success).toBe(true);
    expect(stored.method).toBe('two-point');
    expect(stored.mmPerPx).toBeCloseTo(2, 12);
    const map = photoMapFromCalibration(stored, image, EXTENT)!;
    const back = map.pxToWall([600, 100])!;
    const direct = project(result.homography, [600, 100])!;
    expect(back[0]).toBeCloseTo(direct[0], 9);
    expect(back[1]).toBeCloseTo(direct[1], 9);
    // and the inverse direction
    const px = map.wallToPx(back)!;
    expect(Math.hypot(px[0] - 600, px[1] - 100)).toBeLessThan(1e-9);
  });

  test('a corrupt stored matrix (singular, or with the horizon inside the photo) gives null, not an exception', () => {
    expect(
      photoMapFromCalibration(
        { method: 'manual', homography: [0, 0, 0, 0, 0, 0, 0, 0, 1] },
        image,
        EXTENT,
      ),
    ).toBeNull();
    expect(
      photoMapFromCalibration(
        { method: 'manual', homography: [1, 0, 0, 0, 1, 0, -1 / 500, 0, 1] },
        image,
        EXTENT,
      ),
    ).toBeNull();
  });

  test('a grid fit with more cells than the schema accepts is stored with an evenly spaced subset of points', () => {
    const board = DEFAULT_BOARD;
    const cam = img4937Camera();
    const clicks = [];
    for (let col = 0; col < board.cols; col++) {
      for (let row = 0; row < board.rows; row++) {
        const c = cellCenter(board, { col, row });
        clicks.push({ px: wallToPhoto(cam, [c.x, c.y]), cell: { col, row } });
      }
    }
    expect(clicks.length).toBeGreaterThan(MAX_CALIBRATION_POINTS);
    const result = calibrateFromCorrespondences(
      cellCorrespondences(board, clicks),
      IMG_4937_SIZE,
      'grid',
    );
    const stored = toCoreCalibration(result);
    expect(CalibrationSchema.safeParse(stored).success).toBe(true);
    expect(stored.points).toHaveLength(MAX_CALIBRATION_POINTS);
    expect(stored.method).toBe('grid');
    expect(stored.reprojErrorPx).toBeLessThan(1e-6);
    // the stored matrix, not the subset, defines the map
    const map = photoMapFromCalibration(stored, IMG_4937_SIZE, EXTENT)!;
    const probe = cellCenter(board, { col: 20, row: 10 });
    const px = wallToPhoto(cam, [probe.x, probe.y]);
    const wall = map.pxToWall(px)!;
    expect(Math.hypot(wall[0] - probe.x, wall[1] - probe.y)).toBeLessThan(1e-6);
  });

  test('a calibration with only mmPerPx (from the vision service) becomes a fronto-parallel map', () => {
    const map = photoMapFromCalibration({ method: 'vision', mmPerPx: 0.7 }, image, EXTENT)!;
    expect(map.centerScaleMmPerPx).toBeCloseTo(0.7, 12);
    expect(photoMapFromCalibration({ method: 'manual' }, image, EXTENT)).toBeNull();
  });
});

/**
 * The HSW test photo IMG_4937 (honeycomb wall, known calibration from 300 detected cells, 0.44 px median
 * reprojection error). Clicks are the exact projections of cell centres, optionally with pixel noise added.
 * The photo is taken from ~1.2 m with a 7 / 13 degree tilt, so its scale varies strongly over the frame.
 */
describe('IMG_4937 against its known calibration', () => {
  const camera = img4937Camera();
  const known = createPhotoMap(inv3(homographyFromCamera(camera)), IMG_4937_SIZE);
  const board = DEFAULT_BOARD;

  function cellPx(col: number, row: number, noisePx = 0, random = mulberry32(5)): Vec2 {
    const c = cellCenter(board, { col, row });
    const px = wallToPhoto(camera, [c.x, c.y]);
    return [px[0] + noisePx * gaussian(random), px[1] + noisePx * gaussian(random)];
  }

  /** Known mm/px along the tape at its midpoint: what the two-point scale is supposed to reproduce. */
  function knownScaleAlong(a: Vec2, b: Vec2): number {
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    return known.directionalScaleMmPerPx(mid, [b[0] - a[0], b[1] - a[1]]);
  }

  test('the known calibration is a sane metric plane (~1.7 mm/px, big spread over the frame)', () => {
    expect(known.centerScaleMmPerPx).toBeGreaterThan(1.5);
    expect(known.centerScaleMmPerPx).toBeLessThan(2.0);
    expect(scaleSpread(known).relativeSpread).toBeGreaterThan(0.3);
  });

  test('two clicks on a vertical 70 cm reference on the board give the known scale there within 1%', () => {
    const rows = 30;
    const realMm = rows * board.rowPitchMm;
    const a = cellPx(14, 1);
    const b = cellPx(14, 1 + rows);
    const result = calibrateTwoPoint({ a, b, realMm, axis: 'vertical' }, IMG_4937_SIZE, EXTENT);
    expect(Math.abs(result.mmPerPx / knownScaleAlong(a, b) - 1)).toBeLessThan(0.01);
  });

  test('two clicks on a horizontal 80 cm reference on the board give the known scale there within 1%', () => {
    const cols = 40;
    const realMm = cols * board.colPitchMm;
    const a = cellPx(4, 12);
    const b = cellPx(4 + cols, 12);
    const result = calibrateTwoPoint({ a, b, realMm, axis: 'horizontal' }, IMG_4937_SIZE, EXTENT);
    expect(Math.abs(result.mmPerPx / knownScaleAlong(a, b) - 1)).toBeLessThan(0.01);
  });

  test('a single scale is only valid near the reference: far from the tape this tilted photo is off by >5%', () => {
    const rows = 30;
    const a = cellPx(14, 1);
    const b = cellPx(14, 1 + rows);
    const scale = scaleFromReference({ a, b, realMm: rows * board.rowPitchMm });
    const farTop = known.localScaleMmPerPx([576, 150]);
    expect(Math.abs(scale / farTop - 1)).toBeGreaterThan(0.05);
  });

  test('3 px click errors on a 70 cm reference move the scale by at most the reported bound', () => {
    const rows = 30;
    const realMm = rows * board.rowPitchMm;
    const a = cellPx(14, 1);
    const b = cellPx(14, 1 + rows);
    const exact = scaleFromReference({ a, b, realMm });
    const bound = scaleErrorBound({ a, b, realMm }, 3);
    const towards: Vec2 = [
      (b[0] - a[0]) / referenceLengthPx({ a, b }),
      (b[1] - a[1]) / referenceLengthPx({ a, b }),
    ];
    const off = scaleFromReference({
      a: [a[0] + 3 * towards[0], a[1] + 3 * towards[1]],
      b: [b[0] - 3 * towards[0], b[1] - 3 * towards[1]],
      realMm,
    });
    expect(Math.abs(off / exact - 1)).toBeCloseTo(bound.worstRelativeError, 9);
    // ~0.7 m is ~ 400 px here: 3 px per end costs about 1.5%, and the UI shows exactly this figure.
    expect(bound.worstRelativeError).toBeGreaterThan(0.01);
    expect(bound.worstRelativeError).toBeLessThan(0.03);
    expect(bound.worstMmPerMeter).toBeLessThan(30);
  });

  test('a cell-grid fit from 30 noisy cell centres reproduces the known geometry inside the clicked area to ~1 px', () => {
    const random = mulberry32(9);
    const clicks = [];
    for (let col = 2; col <= 40; col += 6) {
      for (let row = 3; row <= 27; row += 8) {
        clicks.push({ px: cellPx(col, row, 0.5, random), cell: { col, row } });
      }
    }
    const result = calibrateFromCorrespondences(
      cellCorrespondences(board, clicks),
      IMG_4937_SIZE,
      'grid',
    );
    expect(result.reprojection.rmsPx).toBeLessThan(1);
    expect(Math.abs(result.mmPerPx / known.centerScaleMmPerPx - 1)).toBeLessThan(0.01);
    let worst = 0;
    for (const [col, row] of [
      [10, 10],
      [20, 15],
      [30, 20],
      [25, 5],
      [5, 25],
    ] as const) {
      const px = cellPx(col, row);
      const mine = project(result.homography, px)!;
      const truth = known.pxToWall(px)!;
      worst = Math.max(worst, Math.hypot(mine[0] - truth[0], mine[1] - truth[1]));
    }
    // 1 px = ~1.7 mm here
    expect(worst).toBeLessThan(1.7);
  });
});
