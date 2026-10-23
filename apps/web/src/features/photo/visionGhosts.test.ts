import { afterEach, describe, expect, test } from 'bun:test';
import {
  discardAllGhosts,
  discardGhost,
  ghostStore,
  parseToolGhosts,
  ghostPose,
  scaleGhosts,
  setGhosts,
  splitByBoard,
} from './visionGhosts.ts';

afterEach(discardAllGhosts);

function object(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    bboxXywh: [100, 200, 40, 160],
    areaPx: 5000,
    polygon: [
      [100, 200],
      [140, 200],
      [140, 360],
      [100, 360],
    ],
    axis: { deg: 90, unit: [0, 1], centerPx: [120, 280] },
    class: { toolClass: 'screwdriver', label: 'screwdriver', prob: 0.81 },
    confidence: 0.6,
    status: 'ok',
    dimensionsMm: { length: 187, width: 21, thickness: 20 },
    ...over,
  };
}

const image = { w: 1152, h: 1536 };

describe('parseToolGhosts', () => {
  test('reads class, probability, outline and the measured box of a recognised object', () => {
    const parsed = parseToolGhosts({ image, objects: [object(7)] });
    expect(parsed?.image).toEqual({ width: 1152, height: 1536 });
    expect(parsed?.ghosts).toEqual([
      {
        id: 7,
        toolClass: 'screwdriver',
        label: 'screwdriver',
        confidence: 0.81,
        needsConfirmation: false,
        polygonPx: [
          [100, 200],
          [140, 200],
          [140, 360],
          [100, 360],
        ],
        centrePx: [120, 280],
        axisUnit: [0, 1],
        dimsMm: { x: 21, y: 187, z: 20 },
        measured: true,
      },
    ]);
  });

  test('an object without a class gets no ghost but is counted; a failed fit is skipped', () => {
    const parsed = parseToolGhosts({
      image,
      objects: [
        object(1, { class: { toolClass: null, label: null, prob: null } }),
        object(2, { status: 'fit_failed' }),
        object(3),
      ],
    });
    expect(parsed?.ghosts.map((ghost) => ghost.id)).toEqual([3]);
    expect(parsed?.unrecognised).toBe(1);
  });

  test('without a scale the typical size of the class stands in and the ghost says so', () => {
    const parsed = parseToolGhosts({
      image,
      objects: [object(4, { dimensionsMm: null, status: 'no_scale', polygon: undefined })],
    });
    const ghost = parsed?.ghosts[0];
    expect(ghost?.measured).toBe(false);
    expect(ghost?.dimsMm).toEqual({ x: 28, y: 210, z: 28 });
    expect(ghost?.needsConfirmation).toBe(true);
    // No polygon: the bounding box outlines it.
    expect(ghost?.polygonPx).toEqual([
      [100, 200],
      [140, 200],
      [140, 360],
      [100, 360],
    ]);
  });

  test('confidence falls back to the fit confidence, is clamped, and ghosts sort best first', () => {
    const parsed = parseToolGhosts({
      image,
      objects: [
        object(1, { class: { toolClass: 'pliers', label: 'pliers', prob: null }, confidence: 0.4 }),
        object(2, { class: { toolClass: 'hammer', label: 'hammer', prob: 1.7 } }),
      ],
    });
    expect(parsed?.ghosts.map((ghost) => [ghost.id, ghost.confidence])).toEqual([
      [2, 1],
      [1, 0.4],
    ]);
  });

  test('a malformed object is skipped and garbage is not a result', () => {
    expect(parseToolGhosts({ image, objects: [{ id: 'x' }, object(5)] })?.ghosts).toHaveLength(1);
    expect(parseToolGhosts(null)).toBeNull();
    expect(parseToolGhosts({ objects: [] })).toBeNull();
  });
});

describe('ghost store', () => {
  test('ghosts belong to one photo and are dropped one by one or all at once', () => {
    const parsed = parseToolGhosts({ image, objects: [object(1), object(2)] });
    setGhosts('p-1', parsed?.ghosts ?? []);
    expect(ghostStore.get().photoId).toBe('p-1');
    discardGhost(1);
    expect(ghostStore.get().ghosts.map((ghost) => ghost.id)).toEqual([2]);
    discardAllGhosts();
    expect(ghostStore.get()).toEqual({ photoId: null, ghosts: [] });
  });
});

describe('ghostPose', () => {
  // 1 px = 1 mm, wall y up while photo y is down.
  const toWall = (px: readonly [number, number]): readonly [number, number] => [
    px[0],
    1000 - px[1],
  ];
  const base = { centrePx: [200, 300] as const, dimsMm: { x: 30, y: 200, z: 20 } };

  test('a tool lying along the photo x axis is turned a quarter, its butt half a length behind the centre', () => {
    const pose = ghostPose({ ...base, axisUnit: [1, 0] }, toWall);
    expect(pose?.rotZ).toBeCloseTo(-90, 6);
    expect(pose?.x).toBeCloseTo(200 - 100, 6);
    expect(pose?.y).toBeCloseTo(700, 6);
  });

  test('a tool pointing up the photo stands upright with the butt below the centre', () => {
    // Up in the photo is -y, so the axis from the wide end to the narrow end is (0, -1).
    const pose = ghostPose({ ...base, axisUnit: [0, -1] }, toWall);
    expect(pose?.rotZ).toBeCloseTo(0, 6);
    expect(pose?.x).toBeCloseTo(200, 6);
    expect(pose?.y).toBeCloseTo(700 - 100, 6);
  });

  test('without an axis the tool stands upright on the centre; off the wall plane there is no pose', () => {
    expect(ghostPose({ ...base, axisUnit: null }, toWall)).toEqual({ x: 200, y: 600, rotZ: 0 });
    expect(ghostPose({ ...base, axisUnit: [1, 0] }, () => null)).toBeNull();
  });
});

describe('scaleGhosts', () => {
  const parsed = parseToolGhosts({ image: { w: 100, h: 200 }, objects: [object(1)] });
  const ghosts = parsed?.ghosts ?? [];

  test('brings outlines and centres to the size of the stored photo', () => {
    const scaled = scaleGhosts(ghosts, { width: 100, height: 200 }, { width: 300, height: 600 });
    expect(scaled?.[0]?.centrePx).toEqual([360, 840]);
    expect(scaled?.[0]?.polygonPx[2]).toEqual([420, 1080]);
  });

  test('same size is the same ghosts; another aspect ratio is refused', () => {
    expect(scaleGhosts(ghosts, { width: 100, height: 200 }, { width: 100, height: 200 })).toBe(
      ghosts,
    );
    expect(
      scaleGhosts(ghosts, { width: 100, height: 200 }, { width: 200, height: 200 }),
    ).toBeNull();
    expect(scaleGhosts(ghosts, { width: 100, height: 200 }, { width: 0, height: 0 })).toBeNull();
    expect(
      scaleGhosts(ghosts, { width: 100, height: 200 }, { width: Number.NaN, height: 5 }),
    ).toBeNull();
  });
});

describe('splitByBoard', () => {
  test('keeps the ghosts whose spot lies on the board and counts the rest', () => {
    const parsed = parseToolGhosts({
      image,
      objects: [
        object(1, { axis: { centerPx: [100, 100] } }),
        object(2, { axis: { centerPx: [900, 900] } }),
        object(3, { axis: { centerPx: [-5000, 0] } }),
      ],
    });
    // 1 px = 1 mm; the board is 500 x 500 mm; a point beyond the horizon maps to null.
    const split = splitByBoard(
      parsed?.ghosts ?? [],
      (px) => (px[0] < -1000 ? null : [px[0], px[1]]),
      { widthMm: 500, heightMm: 500 },
    );
    expect(split.onBoard.map((ghost) => ghost.id)).toEqual([1]);
    expect(split.offBoard).toBe(2);
  });
});
