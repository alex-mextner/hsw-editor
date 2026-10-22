import { describe, expect, test } from 'bun:test';
import { createPhotoMap } from './photo-map.ts';
import {
  fitHomography,
  isConvexOrdered,
  project,
  reprojectionReport,
  signedArea,
} from './homography.ts';
import type { CameraPose } from './camera.ts';
import { DegenerateError, inv3, type Mat3, type Vec2 } from './matrix.ts';
import {
  gaussian,
  mulberry32,
  photoToWallMatrix,
  syntheticCamera,
  wallToPhoto,
} from './test-helpers.ts';

const IMAGE = { width: 1200, height: 1600 };
const WALL_W = 1200;
const WALL_H = 1000;
const CORNERS: Vec2[] = [
  [0, 0],
  [WALL_W, 0],
  [WALL_W, WALL_H],
  [0, WALL_H],
];

function tiltedCamera(yawDeg: number, pitchDeg: number, rollDeg = 0): CameraPose {
  return syntheticCamera({
    image: IMAGE,
    focalPx: 1100,
    yawDeg,
    pitchDeg,
    rollDeg,
    distanceMm: 2200,
    lookAt: [WALL_W / 2, WALL_H / 2],
  });
}

function pairsFor(camera: CameraPose, wallPoints: readonly Vec2[], noisePx = 0, seed = 1) {
  const random = mulberry32(seed);
  return wallPoints.map((wall) => {
    const px = wallToPhoto(camera, wall);
    return {
      wall,
      px: [px[0] + noisePx * gaussian(random), px[1] + noisePx * gaussian(random)] as Vec2,
    };
  });
}

function grid(nx: number, ny: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) out.push([(i * WALL_W) / (nx - 1), (j * WALL_H) / (ny - 1)]);
  }
  return out;
}

/** Worst wall-space error (mm) of a fitted photo->wall map over a dense grid of wall points. */
function worstMmError(h: Mat3, camera: CameraPose): number {
  let worst = 0;
  for (const wall of grid(9, 9)) {
    const px = wallToPhoto(camera, wall);
    const back = project(h, px);
    if (back === null) throw new Error('lost point');
    worst = Math.max(worst, Math.hypot(back[0] - wall[0], back[1] - wall[1]));
  }
  return worst;
}

describe('fitHomography', () => {
  const tilts: [number, number, number][] = [
    [0, 0, 0],
    [10, 0, 0],
    [0, 15, 0],
    [20, -25, 0],
    [-30, 20, 5],
    [35, 30, -8],
  ];

  test.each(tilts)(
    'recovers the wall plane exactly from 4 corners (yaw %p, pitch %p, roll %p)',
    (yaw, pitch, roll) => {
      const camera = tiltedCamera(yaw, pitch, roll);
      const h = fitHomography(pairsFor(camera, CORNERS));
      expect(worstMmError(h, camera)).toBeLessThan(1e-6);
      expect(reprojectionReport(h, pairsFor(camera, CORNERS)).maxPx).toBeLessThan(1e-6);
    },
  );

  test('a point round-trips photo -> wall -> photo within 1e-9 px', () => {
    const camera = tiltedCamera(18, -12, 3);
    const h = fitHomography(pairsFor(camera, grid(4, 4)));
    for (const wall of grid(7, 5)) {
      const px = wallToPhoto(camera, wall);
      const back = project(inv3(h), project(h, px)!)!;
      expect(Math.hypot(back[0] - px[0], back[1] - px[1])).toBeLessThan(1e-9);
    }
  });

  test('matches the ground-truth matrix of the camera up to scale', () => {
    const camera = tiltedCamera(12, 9);
    const truth = photoToWallMatrix(camera);
    const h = fitHomography(pairsFor(camera, grid(5, 5)));
    const k = truth[8] / h[8];
    for (let i = 0; i < 9; i++) {
      expect(Math.abs(h[i]! * k - truth[i]!)).toBeLessThan(1e-6 * Math.max(1, Math.abs(truth[i]!)));
    }
  });

  test('half-pixel click noise on 4 corners stays within a few mm; more points shrink the error', () => {
    const camera = tiltedCamera(20, 15);
    let four = 0;
    let thirty = 0;
    for (let seed = 1; seed <= 20; seed++) {
      four = Math.max(
        four,
        worstMmError(fitHomography(pairsFor(camera, CORNERS, 0.5, seed)), camera),
      );
      thirty = Math.max(
        thirty,
        worstMmError(fitHomography(pairsFor(camera, grid(6, 5), 0.5, seed)), camera),
      );
    }
    expect(four).toBeLessThan(6);
    expect(thirty).toBeLessThan(four);
    expect(thirty).toBeLessThan(2);
  });

  test('3 px click noise: the report exposes the misfit and wall error stays bounded', () => {
    const camera = tiltedCamera(15, 10);
    const noisy = pairsFor(camera, grid(5, 4), 3, 7);
    const h = fitHomography(noisy);
    const report = reprojectionReport(h, noisy);
    expect(report.rmsPx).toBeGreaterThan(1);
    expect(report.rmsPx).toBeLessThan(6);
    expect(worstMmError(h, camera)).toBeLessThan(20);
  });

  test('rejects fewer than 4 pairs and collinear points', () => {
    const camera = tiltedCamera(5, 5);
    expect(() => fitHomography(pairsFor(camera, CORNERS.slice(0, 3)))).toThrow(DegenerateError);
    const line: Vec2[] = [0, 1, 2, 3, 4].map((i) => [i * 100, 50] as Vec2);
    expect(() => fitHomography(pairsFor(camera, line))).toThrow(DegenerateError);
  });
});

describe('geometry predicates', () => {
  test('convex order and signed area', () => {
    const square: Vec2[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(isConvexOrdered(square)).toBe(true);
    expect(signedArea(square)).toBeCloseTo(1);
    expect(isConvexOrdered([square[0]!, square[2]!, square[1]!, square[3]!])).toBe(false);
    expect(
      isConvexOrdered([
        [0, 0],
        [1, 0],
        [2, 0],
        [0, 1],
      ]),
    ).toBe(false);
  });
});

describe('createPhotoMap', () => {
  test('rejects a calibration whose horizon crosses the photo', () => {
    // w = 1 - x/800 changes sign at x = 800, inside the 1200 px wide photo
    expect(() => createPhotoMap([1, 0, 0, 0, 1, 0, -1 / 800, 0, 1], IMAGE)).toThrow(
      DegenerateError,
    );
  });

  test('local scale of a pure scale matrix is that scale in every direction', () => {
    const map = createPhotoMap([0.5, 0, 0, 0, -0.5, 0, 0, 0, 1], IMAGE);
    expect(map.localScaleMmPerPx([10, 10])).toBeCloseTo(0.5, 12);
    expect(map.directionalScaleMmPerPx([10, 10], [3, 4])).toBeCloseTo(0.5, 12);
  });
});
