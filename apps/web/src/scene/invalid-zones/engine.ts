/**
 * Exact invalid-zone engine: finds, on the real item geometry, WHERE items overlap each other and WHERE they
 * protrude beyond the board prism, and returns those regions as triangle meshes plus structured reasons.
 *
 * Pipeline (rules and pure math live in `@hsw-editor/core` validity.ts):
 * 1. world boxes of the items -> sweep-and-prune broadphase (pairs must overlap deeper than the depth tolerance
 *    on every axis, otherwise no region can exceed it);
 * 2. narrowphase per surviving pair: exact boolean intersection (manifold-3d) of the two posed solids; the shared
 *    volume is the overlap region, its AABB gives the depth, `volume()` the exact volume;
 * 3. bounds: the same boolean against the slabs outside the board prism, only for items whose box reaches one;
 * 4. every result is cached by (solid, pose) of its operands, so after one item moves only the pairs that
 *    involve it are recomputed (all other pairs are cache hits).
 *
 * Deterministic: no randomness, reasons are totally ordered, region order follows the sorted keys.
 * Not thread-affine: runs in a Web Worker in the app and directly under bun in tests and benchmarks.
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import {
  boardSizeMm,
  broadphasePairs,
  compareReasons,
  DEFAULT_VALIDITY_TOLERANCES,
  forbiddenSlabs,
  isBoundsChecked,
  itemWorldAabb,
  mayCollide,
  poseKey,
  poseMatrix,
  sideExtent,
  slabsReachedBy,
  type Aabb,
  type Board,
  type BoundsSide,
  type InvalidReason,
  type ItemKind,
  type Mat4,
  type Pose,
  type ValidityTolerances,
} from '@hsw-editor/core';
import { LruCache } from './lru.ts';
import { regionEdges } from './regionEdges.ts';
import {
  chooseStripeColour,
  colourAt,
  type ColourPart,
  type Rgb,
  type StripeColour,
} from './stripeColour.ts';

/** Triangle mesh in millimetres, item frame (origin = item pose origin). */
export interface SolidMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Material colour of the parts of the solid (item frame), for the stripe colour; absent = unknown. */
  readonly colours?: readonly ColourPart[];
}

export type SolidSpec =
  | { readonly kind: 'mesh'; readonly mesh: SolidMesh }
  | { readonly kind: 'box'; readonly box: Aabb };

export interface EngineItem {
  readonly id: string;
  readonly kind: ItemKind;
  readonly parentId?: string | undefined;
  /** Key of the solid defined with `defineSolid` (a bank model, a variant, or a stand-in box size). */
  readonly solidKey: string;
  readonly pose: Pose;
}

/** One connected invalid patch in world millimetres. */
export interface RegionMesh {
  /** Stable id: `overlap:<idA>:<idB>` (ids sorted) or `bounds:<id>:<side>`. */
  readonly key: string;
  readonly kind: 'overlap' | 'out-of-board';
  /** Items this region belongs to (both parties of an overlap, the protruding item for bounds). */
  readonly itemIds: readonly string[];
  /** Cache key of the (solid, pose) operands the region was computed from: equal keys mean identical geometry. */
  readonly geometryKey: string;
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /** Stripe colour: white where the region covers red-ish material (red stripes would vanish), else red. */
  readonly stripe: StripeColour;
  /** Outline segments (xyz pairs), computed once with the region so the render thread never has to. */
  readonly edges: Float32Array;
}

export interface SolveStats {
  readonly pairsTested: number;
  readonly cacheHits: number;
  readonly booleans: number;
}

export interface SolveResult {
  readonly reasons: InvalidReason[];
  readonly regions: RegionMesh[];
  /** Solid keys that items refer to but that were not defined yet; those items are skipped. */
  readonly pending: string[];
  readonly stats: SolveStats;
}

interface Region {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  readonly edges: Float32Array;
  readonly stripe: StripeColour;
  readonly volumeMm3: number;
  /** Overlap: thinnest width of the region along the item axes; bounds: how far it reaches past the plane. */
  readonly depthMm: number;
}

interface Solid {
  readonly manifold: Manifold;
  readonly localBox: Aabb;
  readonly colours: readonly ColourPart[];
}

/** Smallest slab reach; it doubles until it covers the scene, so far-away items are still clipped and measured. */
const MIN_SLAB_REACH_MM = 5000;
const POSED_CAPACITY = 1024;
const SLAB_CAPACITY = 20;
const REGION_CAPACITY = 4096;

export class InvalidZoneEngine {
  private readonly solids = new Map<string, Solid>();
  private readonly posed: LruCache<Manifold>;
  private readonly regions: LruCache<Region | null>;
  private readonly slabs = new LruCache<Manifold>(SLAB_CAPACITY, (manifold) => manifold.delete());
  /** Solid keys whose mesh could not be turned into a solid. */
  readonly approximateSolids = new Set<string>();

  constructor(
    private readonly wasm: ManifoldToplevel,
    private readonly tolerances: ValidityTolerances = DEFAULT_VALIDITY_TOLERANCES,
  ) {
    this.posed = new LruCache(POSED_CAPACITY, (manifold) => manifold.delete());
    this.regions = new LruCache(REGION_CAPACITY);
  }

  /** Registers (or replaces) the geometry behind a solid key. Replacing drops every cache entry. */
  defineSolid(key: string, spec: SolidSpec): void {
    const existing = this.solids.get(key);
    this.approximateSolids.delete(key);
    if (existing) {
      existing.manifold.delete();
      this.solids.delete(key);
      this.posed.clear();
      this.regions.clear();
    }
    this.solids.set(
      key,
      spec.kind === 'box' ? this.boxSolid(spec.box) : this.meshSolid(key, spec.mesh),
    );
  }

  /** Releases every WASM object. The engine is unusable afterwards. */
  dispose(): void {
    this.posed.clear();
    this.regions.clear();
    for (const solid of this.solids.values()) solid.manifold.delete();
    this.slabs.clear();
    this.solids.clear();
  }

  solve(board: Board, items: readonly EngineItem[]): SolveResult {
    const tol = this.tolerances;
    const pending = new Set<string>();
    const live: { item: EngineItem; solid: Solid; box: Aabb }[] = [];
    for (const item of items) {
      const solid = this.solids.get(item.solidKey);
      if (!solid) {
        pending.add(item.solidKey);
        continue;
      }
      live.push({ item, solid, box: itemWorldAabb(solid.localBox, item.pose) });
    }

    const reasons: InvalidReason[] = [];
    const regions: RegionMesh[] = [];
    let cacheHits = 0;
    let booleans = 0;
    const lookup = (key: string, compute: () => Region | null): Region | null => {
      if (this.regions.has(key)) {
        cacheHits += 1;
        return this.regions.get(key) ?? null;
      }
      booleans += 1;
      const region = compute();
      this.regions.set(key, region);
      return region;
    };

    const reach = slabReach(
      board,
      live.map((entry) => entry.box),
    );
    // Bounds: only items whose box leaves the board prism need a boolean.
    for (const entry of live) {
      if (!isBoundsChecked(entry.item)) continue;
      for (const side of slabsReachedBy(entry.box, board, tol.depthMm)) {
        const key = `bounds|${entry.item.solidKey}@${poseKey(entry.item.pose)}|${boardKey(board)}|${reach}|${side}`;
        const region = lookup(key, () =>
          this.boundsRegion(entry.item, entry.solid, board, reach, side),
        );
        if (!region) continue;
        reasons.push({
          kind: 'out-of-board',
          itemId: entry.item.id,
          side,
          extentMm: region.depthMm,
          volumeMm3: region.volumeMm3,
        });
        regions.push({
          key: `bounds:${entry.item.id}:${side}`,
          kind: 'out-of-board',
          itemIds: [entry.item.id],
          geometryKey: key,
          positions: region.positions,
          indices: region.indices,
          edges: region.edges,
          stripe: region.stripe,
        });
      }
    }

    // Overlaps: pairs must overlap deeper than the tolerance on every axis to possibly exceed it.
    const pairs = broadphasePairs(
      live.map((entry) => entry.box),
      -tol.depthMm,
    );
    let pairsTested = 0;
    for (const [i, j] of pairs) {
      const a = live[i];
      const b = live[j];
      if (!a || !b || !mayCollide(a.item, b.item)) continue;
      pairsTested += 1;
      const operandA = `${a.item.solidKey}@${poseKey(a.item.pose)}`;
      const operandB = `${b.item.solidKey}@${poseKey(b.item.pose)}`;
      // Canonical operand order: the boolean (and its vertex order) must not depend on item order.
      const swap = operandA > operandB;
      const [first, second] = swap ? [b, a] : [a, b];
      const key = swap ? `pair|${operandB}|${operandA}` : `pair|${operandA}|${operandB}`;
      const region = lookup(key, () => this.overlapRegion(first, second));
      if (!region) continue;
      const { depthMm } = region;
      reasons.push(
        {
          kind: 'overlap',
          itemId: a.item.id,
          otherId: b.item.id,
          depthMm,
          volumeMm3: region.volumeMm3,
        },
        {
          kind: 'overlap',
          itemId: b.item.id,
          otherId: a.item.id,
          depthMm,
          volumeMm3: region.volumeMm3,
        },
      );
      const [idLow, idHigh] =
        a.item.id < b.item.id ? [a.item.id, b.item.id] : [b.item.id, a.item.id];
      regions.push({
        key: `overlap:${idLow}:${idHigh}`,
        kind: 'overlap',
        itemIds: [idLow, idHigh],
        geometryKey: key,
        positions: region.positions,
        indices: region.indices,
        edges: region.edges,
        stripe: region.stripe,
      });
    }

    reasons.sort(compareReasons);
    regions.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    return {
      reasons,
      regions,
      pending: [...pending].sort(),
      stats: { pairsTested, cacheHits, booleans },
    };
  }

  private boxSolid(box: Aabb, colours: readonly ColourPart[] = []): Solid {
    const size: [number, number, number] = [
      box.max.x - box.min.x,
      box.max.y - box.min.y,
      box.max.z - box.min.z,
    ];
    const cube = this.wasm.Manifold.cube(size);
    const manifold = cube.translate([box.min.x, box.min.y, box.min.z]);
    cube.delete();
    return { manifold, localBox: box, colours };
  }

  private meshSolid(key: string, mesh: SolidMesh): Solid {
    const localBox = meshBox(mesh.positions);
    const colours = mesh.colours ?? [];
    try {
      const wasmMesh = new this.wasm.Mesh({
        numProp: 3,
        vertProperties: mesh.positions,
        triVerts: mesh.indices,
      });
      // GLB exporters duplicate vertices per face (split normals); welding makes the surface watertight.
      wasmMesh.merge();
      const manifold = new this.wasm.Manifold(wasmMesh);
      if (manifold.status() === 'NoError' && manifold.volume() > 0) {
        return { manifold, localBox, colours };
      }
      manifold.delete();
    } catch {
      // Not a valid solid: fall through to the bounding box.
    }
    this.approximateSolids.add(key);
    return this.boxSolid(localBox, colours);
  }

  /** Posed (world-frame) manifold of an item, cached per (solid, pose). */
  private posedManifold(item: EngineItem, solid: Solid): Manifold {
    const key = `${item.solidKey}@${poseKey(item.pose)}`;
    const cached = this.posed.get(key);
    if (cached) return cached;
    const posed = solid.manifold.transform(poseMatrix(item.pose));
    this.posed.set(key, posed);
    return posed;
  }

  private overlapRegion(
    a: { item: EngineItem; solid: Solid },
    b: { item: EngineItem; solid: Solid },
  ): Region | null {
    const shared = this.posedManifold(a.item, a.solid).intersect(
      this.posedManifold(b.item, b.solid),
    );
    // Curved bodies touch along the line between their centres, which is not an item axis: measure along it too.
    const directions = [
      ...axisDirections(a.item.pose),
      ...axisDirections(b.item.pose),
      ...centreDirections(a, b),
    ];
    return this.takeRegion(
      shared,
      (positions) => thinnestWidth(positions, directions),
      (positions) => stripeColourOf(positions, [a, b]),
    );
  }

  private boundsRegion(
    item: EngineItem,
    solid: Solid,
    board: Board,
    reach: number,
    side: BoundsSide,
  ): Region | null {
    const slab = this.slabManifold(board, reach, side);
    return this.takeRegion(
      this.posedManifold(item, solid).intersect(slab),
      (_positions, box) => sideExtent(box, board, side),
      (positions) => stripeColourOf(positions, [{ item, solid }]),
    );
  }

  private slabManifold(board: Board, reach: number, side: BoundsSide): Manifold {
    const key = `${boardKey(board)}|${reach}|${side}`;
    const cached = this.slabs.get(key);
    if (cached) return cached;
    const slab = forbiddenSlabs(board, reach).find((candidate) => candidate.side === side);
    if (!slab) throw new Error(`no slab for side ${side}`);
    const { min, max } = slab.box;
    const cube = this.wasm.Manifold.cube([max.x - min.x, max.y - min.y, max.z - min.z]);
    const manifold = cube.translate([min.x, min.y, min.z]);
    cube.delete();
    this.slabs.set(key, manifold);
    return manifold;
  }

  /**
   * Reads the region out of a boolean result (freeing it). The result is split into connected pieces and each
   * piece is judged on its own: the thickness of a concave overlap (two slivers on either side of a slot) is that
   * of a sliver, not the distance between them. Pieces within tolerance are dropped; the region keeps the rest.
   */
  private takeRegion(
    result: Manifold,
    depthOf: (positions: Float32Array, box: Aabb) => number,
    stripeOf: (positions: Float32Array) => StripeColour,
  ): Region | null {
    const pieces = result.isEmpty() ? [] : result.decompose();
    result.delete();
    try {
      const positions: Float32Array[] = [];
      const indices: Uint32Array[] = [];
      let vertexCount = 0;
      let volumeMm3 = 0;
      let depthMm = 0;
      for (const piece of pieces) {
        const volume = piece.volume();
        if (volume < this.tolerances.volumeMm3) continue;
        const bounds = piece.boundingBox();
        const box: Aabb = {
          min: { x: bounds.min[0], y: bounds.min[1], z: bounds.min[2] },
          max: { x: bounds.max[0], y: bounds.max[1], z: bounds.max[2] },
        };
        const mesh = piece.getMesh();
        const piecePositions = stridePositions(mesh.vertProperties, mesh.numProp);
        const depth = depthOf(piecePositions, box);
        if (depth < this.tolerances.depthMm) continue;
        const offset = vertexCount;
        positions.push(piecePositions);
        indices.push(mesh.triVerts.map((index) => index + offset));
        vertexCount += piecePositions.length / 3;
        volumeMm3 += volume;
        depthMm = Math.max(depthMm, depth);
      }
      if (positions.length === 0) return null;
      const merged = {
        positions: concat(positions, Float32Array),
        indices: concat(indices, Uint32Array),
      };
      return {
        ...merged,
        edges: regionEdges(merged.positions, merged.indices),
        stripe: stripeOf(merged.positions),
        volumeMm3,
        depthMm,
      };
    } finally {
      for (const piece of pieces) piece.delete();
    }
  }
}

/** At most this many region vertices are looked up per item: enough to tell a red handle from a grey shaft. */
const MAX_COLOUR_SAMPLES = 48;

/**
 * Stripe colour of a region (world-frame positions): the base colour of each involved item at the region's
 * vertices, found by carrying them back into the item frame.
 */
function stripeColourOf(
  positions: Float32Array,
  targets: readonly { item: EngineItem; solid: Solid }[],
): StripeColour {
  const count = positions.length / 3;
  const step = Math.max(1, Math.floor(count / MAX_COLOUR_SAMPLES));
  const samples: (Rgb | null)[] = [];
  for (const { item, solid } of targets) {
    if (solid.colours.length === 0) continue;
    const m = poseMatrix(item.pose);
    for (let v = 0; v < count; v += step) {
      const [x, y, z] = toItemFrame(
        m,
        positions[v * 3] ?? 0,
        positions[v * 3 + 1] ?? 0,
        positions[v * 3 + 2] ?? 0,
      );
      samples.push(colourAt(solid.colours, x, y, z));
    }
  }
  return chooseStripeColour(samples);
}

/** Inverse of a pose matrix applied to a world point. Poses are rigid (rotation + translation): the inverse is the transpose. */
function toItemFrame(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  const dx = x - m[12];
  const dy = y - m[13];
  const dz = z - m[14];
  return [
    m[0] * dx + m[1] * dy + m[2] * dz,
    m[4] * dx + m[5] * dy + m[6] * dz,
    m[8] * dx + m[9] * dy + m[10] * dz,
  ];
}

function concat<T extends Float32Array | Uint32Array>(
  parts: readonly T[],
  Type: { new (length: number): T },
): T {
  const out = new Type(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** World-frame centre of an item's local bounding box. */
function worldCentre(entry: { item: EngineItem; solid: Solid }): [number, number, number] {
  const { min, max } = entry.solid.localBox;
  const m = poseMatrix(entry.item.pose);
  const [x, y, z] = [(min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Unit vectors along the line between the two centres, and along its wall-plane part (bodies grow out of the wall). */
function centreDirections(
  a: { item: EngineItem; solid: Solid },
  b: { item: EngineItem; solid: Solid },
): [number, number, number][] {
  const [ax, ay, az] = worldCentre(a);
  const [bx, by, bz] = worldCentre(b);
  const out: [number, number, number][] = [];
  for (const [dx, dy, dz] of [
    [bx - ax, by - ay, bz - az],
    [bx - ax, by - ay, 0],
  ] as const) {
    const length = Math.hypot(dx, dy, dz);
    if (length > 1e-9) out.push([dx / length, dy / length, dz / length]);
  }
  return out;
}

/** World axes plus the item's own axes: the directions a pair separates along (box faces, hex-rotated faces). */
function axisDirections(pose: Pose): [number, number, number][] {
  const m = poseMatrix(pose);
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];
}

/** Smallest extent of the points projected on any of the unit `directions`. */
function thinnestWidth(
  positions: Float32Array,
  directions: readonly [number, number, number][],
): number {
  let thinnest = Infinity;
  for (const [dx, dy, dz] of directions) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const d =
        (positions[i] ?? 0) * dx + (positions[i + 1] ?? 0) * dy + (positions[i + 2] ?? 0) * dz;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    thinnest = Math.min(thinnest, hi - lo);
  }
  return thinnest;
}

/** Slab reach covering every item box (and the board), as MIN_SLAB_REACH_MM times a power of two. */
function slabReach(board: Board, boxes: readonly Aabb[]): number {
  const { width, height } = boardSizeMm(board);
  let farthest = Math.max(width, height);
  for (const { min, max } of boxes) {
    farthest = Math.max(
      farthest,
      Math.abs(min.x),
      Math.abs(max.x),
      Math.abs(min.y),
      Math.abs(max.y),
      Math.abs(min.z),
      Math.abs(max.z),
    );
  }
  let reach = MIN_SLAB_REACH_MM;
  while (reach < 2 * farthest) reach *= 2;
  return reach;
}

function boardKey(board: Board): string {
  return `${board.cols}x${board.rows}@${board.colPitchMm},${board.rowPitchMm}`;
}

function meshBox(positions: Float32Array): Aabb {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    min.x = Math.min(min.x, x);
    min.y = Math.min(min.y, y);
    min.z = Math.min(min.z, z);
    max.x = Math.max(max.x, x);
    max.y = Math.max(max.y, y);
    max.z = Math.max(max.z, z);
  }
  return { min, max };
}

/** Copies the xyz of an interleaved vertex property array (the first three channels are the position). */
function stridePositions(props: Float32Array, numProp: number): Float32Array {
  if (numProp === 3) return Float32Array.from(props);
  const count = Math.floor(props.length / numProp);
  const out = new Float32Array(count * 3);
  for (let v = 0; v < count; v += 1) {
    out[v * 3] = props[v * numProp] ?? 0;
    out[v * 3 + 1] = props[v * numProp + 1] ?? 0;
    out[v * 3 + 2] = props[v * numProp + 2] ?? 0;
  }
  return out;
}
