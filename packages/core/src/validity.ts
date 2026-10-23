/**
 * Geometric validity rules of a wall: what counts as an invalid overlap or protrusion, and the pure math
 * the exact checkers (apps/web `scene/invalid-zones`) build on. Nothing here touches meshes, so the core stays
 * dependency-free; the narrowphase over real bank geometry lives next to the renderer.
 *
 * The verdicts are advisory, exactly like `checkWall` warnings: they never block an op and a wall with invalid
 * zones can be saved.
 *
 * Rules
 * - Two solid items (anything but a `photo-ref`) must not share volume. Touching faces are fine; a tool may
 *   interpenetrate the holder named by its `parentId` (that is the mating interface). Penetration is judged on
 *   the real geometry, not on grid cells (a cell-footprint test misses bodies that overlap above their cells).
 * - Every solid must lie inside the board prism: x in [0, width], y in [0, height], z >= 0 (nothing behind the
 *   wall face; bank elements are modelled with the wall face at z = 0, so their plugs/screw bosses sit on it).
 * - A defect is only reported above `ValidityTolerances`: contact noise (coincident faces, float rounding) is
 *   neither a thin sliver of a real overlap nor a physical problem.
 */
import { boardSizeMm, type Board } from './grid.ts';
import type { Id, Pose, WallItem } from './schema.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export interface ValidityTolerances {
  /** Overlaps and protrusions thinner than this (mm, thinnest width of the region along the item and world axes) are contact. */
  depthMm: number;
  /** Regions smaller than this (mm^3) are numerical noise. */
  volumeMm3: number;
}

/** Defaults: any real overlap of 0.05 mm depth and 0.5 mm^3 is flagged (a 0.1 mm sliver over a holder face is). */
export const DEFAULT_VALIDITY_TOLERANCES: ValidityTolerances = { depthMm: 0.05, volumeMm3: 0.5 };

export const BOUNDS_SIDES = ['left', 'right', 'bottom', 'top', 'behind-wall'] as const;
/** The part of the space outside the board prism a region lies in; `left`/`right` also own everything beyond them. */
export type BoundsSide = (typeof BOUNDS_SIDES)[number];

export interface OverlapReason {
  kind: 'overlap';
  itemId: Id;
  otherId: Id;
  /** Thinnest width of the shared volume along the world axes and both items' own axes: the least shift that separates the pair. */
  depthMm: number;
  volumeMm3: number;
}

export interface OutOfBoardReason {
  kind: 'out-of-board';
  itemId: Id;
  side: BoundsSide;
  /** How far the item reaches past the board plane of `side`. */
  extentMm: number;
  volumeMm3: number;
}

export type InvalidReason = OverlapReason | OutOfBoardReason;

/** Column-major 4x4 matrix. */
export type Mat4 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const DEG = Math.PI / 180;

/**
 * Column-major 4x4 matrix of an item pose, the same convention three.js uses for `Euler(x, y, z, 'XYZ')`
 * followed by a translation (the editor draws items with exactly that), so geometry, picking and validity agree.
 */
export function poseMatrix(pose: Pose): Mat4 {
  // three.js Matrix4.makeRotationFromEuler, order 'XYZ': a/b = cos/sin of rotX, c/d of rotY, e/f of rotZ.
  const a = Math.cos(pose.rotX * DEG);
  const b = Math.sin(pose.rotX * DEG);
  const c = Math.cos(pose.rotY * DEG);
  const d = Math.sin(pose.rotY * DEG);
  const e = Math.cos(pose.rotZ * DEG);
  const f = Math.sin(pose.rotZ * DEG);
  const ae = a * e;
  const af = a * f;
  const be = b * e;
  const bf = b * f;
  // prettier-ignore
  return [
    c * e, af + be * d, bf - ae * d, 0,
    -c * f, ae - bf * d, be + af * d, 0,
    d, -b * c, a * c, 0,
    pose.x, pose.y, pose.z, 1,
  ];
}

/** Tight axis-aligned box of `local` after applying the affine column-major `matrix`. */
export function transformAabb(local: Aabb, matrix: Readonly<Mat4>): Aabb {
  // Start from the translation column, then add each input axis' contribution to each output axis.
  const out: Aabb = {
    min: { x: matrix[12], y: matrix[13], z: matrix[14] },
    max: { x: matrix[12], y: matrix[13], z: matrix[14] },
  };
  const axes = ['x', 'y', 'z'] as const;
  for (const [row, outAxis] of axes.entries()) {
    for (const [col, inAxis] of axes.entries()) {
      const coefficient = matrix[col * 4 + row] ?? 0;
      const lo = coefficient * local.min[inAxis];
      const hi = coefficient * local.max[inAxis];
      out.min[outAxis] += Math.min(lo, hi);
      out.max[outAxis] += Math.max(lo, hi);
    }
  }
  return out;
}

/** World box of an item whose geometry has `localBox` in the item frame. */
export function itemWorldAabb(localBox: Aabb, pose: Pose): Aabb {
  return transformAabb(localBox, poseMatrix(pose));
}

/** Stable text key of a pose rounded to 1 micrometre / 1 millidegree, for caches. */
export function poseKey(pose: Pose): string {
  // `+ 0` folds -0 into 0; non-finite poses keep their own text so they never alias the origin pose.
  const q = (value: number, scale: number): number | string =>
    Number.isFinite(value) ? Math.round(value * scale) + 0 : String(value);
  return [
    q(pose.x, 1000),
    q(pose.y, 1000),
    q(pose.z, 1000),
    q(pose.rotX, 1000),
    q(pose.rotY, 1000),
    q(pose.rotZ, 1000),
  ].join(',');
}

/** Solid items take part in overlap checks; photo references are flat drawings, not parts. */
export function isSolid(item: Pick<WallItem, 'kind'>): boolean {
  return item.kind !== 'photo-ref';
}

/**
 * Whether the item must stay inside the board prism. A hung tool's free end may overhang the board edge (user rule
 * tg#24300: whether it still hangs well is the physics check's question, not geometry's), so only holders and board
 * parts are held to the prism. Overlap checks (`mayCollide`) are unaffected.
 */
export function isBoundsChecked(item: Pick<WallItem, 'kind'>): boolean {
  return isSolid(item) && item.kind !== 'tool';
}

/**
 * Whether the overlap of two items is a defect worth testing. A tool interpenetrating the holder it is parented to
 * is the mating interface (the pocket is not modelled as a cavity of the right size), not a collision. Two tools in
 * the same holder are still checked against each other: sharing a holder does not allow them to share volume.
 */
export function mayCollide(
  a: Pick<WallItem, 'id' | 'kind' | 'parentId'>,
  b: Pick<WallItem, 'id' | 'kind' | 'parentId'>,
): boolean {
  if (a.id === b.id || !isSolid(a) || !isSolid(b)) return false;
  if (a.parentId === b.id || b.parentId === a.id) return false;
  return true;
}

/**
 * Pairs of boxes that share MORE than `-margin` of extent on every axis: `margin = 0` pairs boxes sharing positive
 * volume (boxes that merely touch are not paired); a negative margin demands a deeper overlap, a positive one also
 * pairs near misses. Sweep and prune on x (the prune is only an optimisation: the pair test below is the contract),
 * O(n log n + pairs). Returns index pairs `[i, j]` with `i < j`, sorted.
 */
export function broadphasePairs(boxes: readonly Aabb[], margin = 0): [number, number][] {
  const shared = (aLo: number, aHi: number, bLo: number, bHi: number): boolean =>
    Math.min(aHi, bHi) - Math.max(aLo, bLo) > -margin;
  const order = boxes
    .map((_, index) => index)
    .sort((p, q) => minX(boxes, p) - minX(boxes, q) || p - q);
  const pairs: [number, number][] = [];
  const active: number[] = [];
  for (const index of order) {
    const box = boxes[index];
    if (box === undefined) continue;
    let write = 0;
    for (const other of active) {
      const o = boxes[other];
      if (o === undefined) continue;
      if (o.max.x + margin <= box.min.x) continue; // swept past: no later box (min.x only grows) can pair with it
      active[write++] = other;
      if (
        shared(box.min.x, box.max.x, o.min.x, o.max.x) &&
        shared(box.min.y, box.max.y, o.min.y, o.max.y) &&
        shared(box.min.z, box.max.z, o.min.z, o.max.z)
      ) {
        pairs.push(index < other ? [index, other] : [other, index]);
      }
    }
    active.length = write;
    active.push(index);
  }
  return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

function minX(boxes: readonly Aabb[], index: number): number {
  return boxes[index]?.min.x ?? Infinity;
}

/** A forbidden slab of space around the board prism; the parts partition everything outside it. */
export interface ForbiddenSlab {
  side: BoundsSide;
  box: Aabb;
}

/**
 * Everything outside the allowed board prism as five disjoint boxes, each reaching `reachMm` beyond the board
 * (choose it larger than any item). Intersecting an item with them yields its protrusion regions.
 */
export function forbiddenSlabs(board: Board, reachMm: number): ForbiddenSlab[] {
  const { width, height } = boardSizeMm(board);
  const r = reachMm;
  const slab = (side: BoundsSide, min: Vec3, max: Vec3): ForbiddenSlab => ({
    side,
    box: { min, max },
  });
  return [
    slab('left', { x: -r, y: -r, z: -r }, { x: 0, y: height + r, z: r }),
    slab('right', { x: width, y: -r, z: -r }, { x: width + r, y: height + r, z: r }),
    slab('bottom', { x: 0, y: -r, z: -r }, { x: width, y: 0, z: r }),
    slab('top', { x: 0, y: height, z: -r }, { x: width, y: height + r, z: r }),
    slab('behind-wall', { x: 0, y: 0, z: -r }, { x: width, y: height, z: 0 }),
  ];
}

/** Slabs a world box may reach (cheap gate before any exact work); `tolMm` ignores touching/rounding. */
export function slabsReachedBy(box: Aabb, board: Board, tolMm: number): BoundsSide[] {
  const { width, height } = boardSizeMm(board);
  const sides: BoundsSide[] = [];
  if (box.min.x < -tolMm) sides.push('left');
  if (box.max.x > width + tolMm) sides.push('right');
  if (box.min.y < -tolMm) sides.push('bottom');
  if (box.max.y > height + tolMm) sides.push('top');
  if (box.min.z < -tolMm) sides.push('behind-wall');
  return sides;
}

/** How far a region box reaches past the board plane of `side`; meaningful for boxes clipped to that slab (negative inside the board). */
export function sideExtent(box: Aabb, board: Board, side: BoundsSide): number {
  const { width, height } = boardSizeMm(board);
  switch (side) {
    case 'left':
      return -box.min.x;
    case 'right':
      return box.max.x - width;
    case 'bottom':
      return -box.min.y;
    case 'top':
      return box.max.y - height;
    case 'behind-wall':
      return -box.min.z;
  }
}

const tieKey = (reason: InvalidReason): string =>
  reason.kind === 'overlap' ? reason.otherId : reason.side;

/** Total order for reasons so results are byte-stable regardless of discovery order. */
export function compareReasons(a: InvalidReason, b: InvalidReason): number {
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const keyA = tieKey(a);
  const keyB = tieKey(b);
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}
