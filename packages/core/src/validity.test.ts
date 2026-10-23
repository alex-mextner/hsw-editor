import { describe, expect, test } from 'bun:test';
import { boardSizeMm, DEFAULT_BOARD } from './grid.ts';
import { PoseSchema } from './schema.ts';
import {
  broadphasePairs,
  compareReasons,
  forbiddenSlabs,
  isBoundsChecked,
  itemWorldAabb,
  mayCollide,
  poseKey,
  poseMatrix,
  sideExtent,
  slabsReachedBy,
  transformAabb,
  type Aabb,
  type InvalidReason,
} from './validity.ts';

const pose = (partial: Record<string, number> = {}) => PoseSchema.parse(partial);
const box = (min: [number, number, number], max: [number, number, number]): Aabb => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
});

/** Reference implementation: apply the matrix to a point. */
function apply(m: readonly number[], p: [number, number, number]): [number, number, number] {
  const g = (i: number) => m[i] ?? 0;
  return [
    g(0) * p[0] + g(4) * p[1] + g(8) * p[2] + g(12),
    g(1) * p[0] + g(5) * p[1] + g(9) * p[2] + g(13),
    g(2) * p[0] + g(6) * p[1] + g(10) * p[2] + g(14),
  ];
}

describe('poseMatrix', () => {
  test('rotZ 90 maps +x to +y and translates', () => {
    const m = poseMatrix(pose({ x: 10, y: 20, z: 3, rotZ: 90 }));
    const [x, y, z] = apply(m, [1, 0, 0]);
    expect(x).toBeCloseTo(10, 9);
    expect(y).toBeCloseTo(21, 9);
    expect(z).toBeCloseTo(3, 9);
  });

  test('matches three.js Euler XYZ order (Rx * Ry * Rz): rotZ applies first', () => {
    // v = Rx(90) * Rz(90) * (1,0,0): Rz -> (0,1,0); Rx(90) -> (0,0,1)
    const m = poseMatrix(pose({ rotX: 90, rotZ: 90 }));
    const [x, y, z] = apply(m, [1, 0, 0]);
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(1, 9);
  });
});

describe('transformAabb', () => {
  test('a rotated box is bounded by its rotated corners', () => {
    const local = box([-10, -5, 0], [10, 5, 4]);
    const m = poseMatrix(pose({ x: 100, y: 50, rotZ: 90 }));
    const world = transformAabb(local, m);
    expect(world.min.x).toBeCloseTo(95, 9);
    expect(world.max.x).toBeCloseTo(105, 9);
    expect(world.min.y).toBeCloseTo(40, 9);
    expect(world.max.y).toBeCloseTo(60, 9);
    expect(world.max.z).toBeCloseTo(4, 9);
  });

  test('equals the box of the eight transformed corners for arbitrary rotation', () => {
    const local = box([-3, -7, 1], [11, 2, 9]);
    const p = pose({ x: 5, y: -2, z: 1, rotX: 20, rotY: 35, rotZ: 70 });
    const m = poseMatrix(p);
    const world = itemWorldAabb(local, p);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const x of [local.min.x, local.max.x])
      for (const y of [local.min.y, local.max.y])
        for (const z of [local.min.z, local.max.z]) {
          apply(m, [x, y, z]).forEach((v, i) => {
            min[i] = Math.min(min[i] ?? 0, v);
            max[i] = Math.max(max[i] ?? 0, v);
          });
        }
    expect([world.min.x, world.min.y, world.min.z]).toEqual(min.map((v) => expect.closeTo(v, 9)));
    expect([world.max.x, world.max.y, world.max.z]).toEqual(max.map((v) => expect.closeTo(v, 9)));
  });
});

describe('broadphasePairs', () => {
  test('touching boxes are not paired, overlapping ones are', () => {
    const boxes = [
      box([0, 0, 0], [10, 10, 10]),
      box([10, 0, 0], [20, 10, 10]), // touches the first on x = 10
      box([9.9, 0, 0], [20, 10, 10]), // overlaps the first by 0.1
    ];
    expect(broadphasePairs(boxes)).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });

  test('a negative margin demands a deeper overlap on every axis', () => {
    const boxes = [box([0, 0, 0], [10, 10, 10]), box([9.9, 0, 0], [20, 10, 10])];
    expect(broadphasePairs(boxes, 0)).toEqual([[0, 1]]);
    expect(broadphasePairs(boxes, -0.2)).toEqual([]);
  });

  test('negative margin: a thin box nested inside another is not paired unless it is deep enough', () => {
    const big = box([0, 0, 0], [100, 100, 100]);
    // x variant: overlap is 2 mm wide, the prune alone would keep it
    expect(broadphasePairs([big, box([10, 10, 10], [12, 100, 100])], -5)).toEqual([]);
    expect(broadphasePairs([big, box([10, 10, 10], [12, 100, 100])], -1)).toEqual([[0, 1]]);
    // y variant: a 3 mm slab nested in y
    expect(broadphasePairs([big, box([10, 40, 10], [50, 43, 50])], -5)).toEqual([]);
  });

  test('positive margin pairs near misses; zero-thickness boxes share no volume', () => {
    const a = box([0, 0, 0], [10, 10, 10]);
    expect(broadphasePairs([a, box([10.5, 0, 0], [20, 10, 10])], 1)).toEqual([[0, 1]]);
    expect(broadphasePairs([a, box([10.5, 0, 0], [20, 10, 10])], 0)).toEqual([]);
    expect(broadphasePairs([a, box([5, 5, 5], [5, 8, 8])], 0)).toEqual([]);
  });

  test('empty and single inputs', () => {
    expect(broadphasePairs([])).toEqual([]);
    expect(broadphasePairs([box([0, 0, 0], [1, 1, 1])])).toEqual([]);
  });

  test('matches brute force on 300 random boxes', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const boxes: Aabb[] = [];
    for (let i = 0; i < 300; i++) {
      const x = rnd() * 400;
      const y = rnd() * 300;
      const z = rnd() * 40;
      boxes.push(box([x, y, z], [x + 5 + rnd() * 60, y + 5 + rnd() * 60, z + 5 + rnd() * 30]));
    }
    const expected: [number, number][] = [];
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        if (
          a.min.x < b.max.x &&
          b.min.x < a.max.x &&
          a.min.y < b.max.y &&
          b.min.y < a.max.y &&
          a.min.z < b.max.z &&
          b.min.z < a.max.z
        )
          expected.push([i, j]);
      }
    expect(broadphasePairs(boxes)).toEqual(expected);
  });
});

describe('board prism', () => {
  const { width, height } = boardSizeMm(DEFAULT_BOARD);

  test('slabs are the five disjoint parts of the outside', () => {
    const slabs = forbiddenSlabs(DEFAULT_BOARD, 500);
    expect(slabs.map((s) => s.side)).toEqual(['left', 'right', 'bottom', 'top', 'behind-wall']);
    // No two slabs share volume.
    expect(broadphasePairs(slabs.map((s) => s.box))).toEqual([]);
  });

  test('items inside the prism reach no slab, touching the plane is allowed', () => {
    expect(slabsReachedBy(box([0, 0, 0], [50, 50, 30]), DEFAULT_BOARD, 0.05)).toEqual([]);
    expect(slabsReachedBy(box([-0.04, 0, 0], [50, 50, 30]), DEFAULT_BOARD, 0.05)).toEqual([]);
  });

  test('slabsReachedBy agrees with the exact slab intersection for a corner-straddling box', () => {
    const straddling = box([-1, height + 1, 0], [30, height + 9, 30]);
    expect(slabsReachedBy(straddling, DEFAULT_BOARD, 0.05)).toEqual(['left', 'top']);
    expect(sideExtent(box([-1, 0, 0], [5, 5, 5]), DEFAULT_BOARD, 'left')).toBeCloseTo(1, 9);
    expect(sideExtent(box([0, height, 0], [5, height + 9, 5]), DEFAULT_BOARD, 'top')).toBeCloseTo(
      9,
      9,
    );
    expect(sideExtent(box([0, 0, -2.5], [5, 5, 5]), DEFAULT_BOARD, 'behind-wall')).toBeCloseTo(
      2.5,
      9,
    );
  });

  test('protrusion past each plane is detected and measured', () => {
    expect(slabsReachedBy(box([-6, 0, 0], [50, 50, 30]), DEFAULT_BOARD, 0.05)).toEqual(['left']);
    expect(slabsReachedBy(box([0, 0, -2], [50, height + 3, 30]), DEFAULT_BOARD, 0.05)).toEqual([
      'top',
      'behind-wall',
    ]);
    expect(
      sideExtent(box([width - 10, 0, 0], [width + 6, 5, 5]), DEFAULT_BOARD, 'right'),
    ).toBeCloseTo(6, 9);
    expect(sideExtent(box([0, -3.5, 0], [5, 5, 5]), DEFAULT_BOARD, 'bottom')).toBeCloseTo(3.5, 9);
  });
});

describe('mayCollide', () => {
  const holder = { id: 'h1', kind: 'holder' as const };
  const tool = { id: 't1', kind: 'tool' as const, parentId: 'h1' };
  const other = { id: 't2', kind: 'tool' as const };

  test('a tool and its parent holder mate by design', () => {
    expect(mayCollide(holder, tool)).toBe(false);
    expect(mayCollide(tool, holder)).toBe(false);
  });

  test('an item never collides with itself; two tools of one holder still collide with each other', () => {
    expect(mayCollide(holder, holder)).toBe(false);
    expect(mayCollide(tool, { id: 't3', kind: 'tool' as const, parentId: 'h1' })).toBe(true);
  });

  test('unrelated solids collide, photo references never do', () => {
    expect(mayCollide(holder, other)).toBe(true);
    expect(mayCollide(tool, other)).toBe(true);
    expect(mayCollide(holder, { id: 'p', kind: 'photo-ref' })).toBe(false);
  });
});

describe('isBoundsChecked', () => {
  test('holders and board parts must stay in the prism; a tool may overhang the board edge (tg#24300)', () => {
    expect(isBoundsChecked({ kind: 'holder' })).toBe(true);
    expect(isBoundsChecked({ kind: 'board-part' })).toBe(true);
    expect(isBoundsChecked({ kind: 'tool' })).toBe(false);
    expect(isBoundsChecked({ kind: 'photo-ref' })).toBe(false);
  });
});

describe('poseKey / compareReasons', () => {
  test('pose keys round at micrometres and are stable', () => {
    expect(poseKey(pose({ x: 1.0000001 }))).toBe(poseKey(pose({ x: 1 })));
    expect(poseKey(pose({ x: 1.001 }))).not.toBe(poseKey(pose({ x: 1 })));
    expect(poseKey(pose({ rotZ: -0 }))).toBe(poseKey(pose()));
    expect(poseKey({ ...pose(), x: Number.NaN })).not.toBe(poseKey(pose()));
    expect(poseKey({ rotZ: 0, rotY: 0, rotX: 0, z: 0, y: 2, x: 1 })).toBe(
      poseKey(pose({ x: 1, y: 2 })),
    );
  });

  test('reasons sort by item, kind, then other id / side', () => {
    const reasons: InvalidReason[] = [
      { kind: 'out-of-board', itemId: 'b', side: 'top', extentMm: 1, volumeMm3: 1 },
      { kind: 'overlap', itemId: 'b', otherId: 'z', depthMm: 1, volumeMm3: 1 },
      { kind: 'overlap', itemId: 'a', otherId: 'y', depthMm: 1, volumeMm3: 1 },
      { kind: 'overlap', itemId: 'b', otherId: 'c', depthMm: 1, volumeMm3: 1 },
    ];
    const sorted = [...reasons].sort(compareReasons);
    expect(
      sorted.map((r) => `${r.itemId}:${r.kind}:${r.kind === 'overlap' ? r.otherId : r.side}`),
    ).toEqual(['a:overlap:y', 'b:out-of-board:top', 'b:overlap:c', 'b:overlap:z']);
  });
});
