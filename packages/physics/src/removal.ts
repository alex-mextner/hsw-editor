/**
 * Removal ergonomics: can a hand take the tool off its holder, and how comfortably? The extraction paths a hand
 * uses (lift out, pull forward, a short lift then a pull, each optionally after tilting the tool about its seat)
 * are swept against everything else on the wall: the holder's lips, neighbouring holders and tools, shelves and
 * the board. Straight motions along the wall axes are decided exactly on the column rasters (a rise or a pull is
 * limited by the first obstacle span above the tool in the direction of motion); the cheapest free path is then
 * verified and its clearance measured with exact mesh booleans and gaps (manifold-3d) along the whole path.
 */
import { apply, type Mat3, multiply, rotationX, rotationZ, type Vec3 } from '@hsw-editor/compat';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import {
  type Placement,
  type SolidBody,
  type ToolBody,
  boundsOverlap,
  worldBounds,
} from './body.ts';
import { CELL_MM } from './body.ts';
import { type ColumnGrid, rasterize } from './columns.ts';
import { riseLimit, scanAll } from './settle.ts';

export type RemovalVerdict = 'free' | 'needs_tilt' | 'needs_two_hands' | 'blocked';

export type RemovalReasonCode =
  | 'blocked'
  | 'needs_tilt'
  | 'heavy'
  | 'cramped'
  | 'long_lift'
  | 'tight_clearance';

export interface RemovalReason {
  code: RemovalReasonCode;
  params: Readonly<Record<string, number | string | readonly string[]>>;
}

export interface RemovalReport {
  verdict: RemovalVerdict;
  /** 0 (cannot be taken off) .. 1 (lifts straight out with room to spare). */
  convenience: number;
  /** Smallest gap (mm) between the tool and a neighbour (not the holder, not the board) along the path; capped at `searchMm`. */
  clearanceMm: number;
  /** Smallest gap (mm) to a neighbour in the rest pose (room for fingers). */
  neighbourGapMm: number;
  /** `lift`, `pull`, `lift 15 mm, pull`, with the tilt prefix (`tilt x +15 deg`) when one is needed; null when blocked. */
  path: string | null;
  liftMm: number;
  pullMm: number;
  /** Ids of the obstacles in the way (when blocked). */
  blockedBy: string[];
  reasons: RemovalReason[];
}

export interface RemovalOptions {
  /** Space a hand needs beside the grip (mm); less than this to a neighbour is cramped. */
  fingerRoomMm: number;
  /** Tools heavier than this (g) need a second hand under them. */
  heavyG: number;
  /** Lifting a tool higher than this (mm) to free it is beyond a comfortable one-hand motion. */
  longLiftMm: number;
  /** Gaps are measured up to this distance (mm). */
  searchMm: number;
  /** Tilt angles tried (degrees) when the straight paths are blocked. */
  tiltsDeg: readonly number[];
  /** Short lifts (mm) tried before a pull. */
  shortLiftsMm: readonly number[];
}

export const DEFAULT_REMOVAL_OPTIONS: RemovalOptions = {
  fingerRoomMm: 12,
  heavyG: 2500,
  longLiftMm: 450,
  searchMm: 60,
  tiltsDeg: [12, 25],
  shortLiftsMm: [4, 8, 15, 30, 60, 120],
};

export interface RemovalInput {
  tool: ToolBody;
  placement: Placement;
  /** The holder the tool hangs on: its own contact is not a collision, its lips are. */
  holder: SolidBody;
  /** Other holders, neighbouring tools, shelves. */
  neighbours: readonly SolidBody[];
  /** Point the tool tilts about when it has to (the seat contact); defaults to the tool origin. */
  pivot?: Vec3;
  options?: Partial<RemovalOptions>;
}

interface Pose {
  rotation: Mat3;
  position: Vec3;
}

/** Candidate extraction path: a lift, then a pull, from a pose. */
interface Path {
  liftMm: number;
  pullMm: number;
  from: Pose;
  tilt: { axis: 'x' | 'z'; deg: number } | null;
}

const TOUCH_MM = 0.02;
const OVERLAP_MM3 = 1;
const VERIFY_STEP_MM = 12;
const WALL_SIZE_MM = 20000;
/** Rotation taking +Z to +Y: the column grid then measures motion along the wall normal. */
const Z_UP: Mat3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];

export class RemovalProbe {
  private readonly bodies = new WeakMap<SolidBody, Manifold>();
  private readonly tools = new WeakMap<ToolBody, Manifold>();
  private wall: Manifold | null = null;

  constructor(private readonly wasm: ManifoldToplevel) {}

  analyse(input: RemovalInput): RemovalReport {
    const options: RemovalOptions = { ...DEFAULT_REMOVAL_OPTIONS, ...input.options };
    const { tool, placement, holder } = input;
    const bounds = worldBounds(tool, placement);
    const sweepBox = {
      min: [bounds.min[0] - 20, bounds.min[1] - 20, bounds.min[2] - 20] as Vec3,
      max: [
        bounds.max[0] + 20,
        bounds.max[1] + bounds.max[1] - bounds.min[1] + 40,
        bounds.max[2] + 250,
      ] as Vec3,
    };
    const neighbours = input.neighbours.filter(
      (o) => o !== holder && boundsOverlap(sweepBox, o.bounds(), 0),
    );
    const bodies = [holder, ...neighbours];
    const start: Pose = { rotation: placement.rotation, position: placement.position };
    const pivot = input.pivot ?? placement.position;

    const neighbourGap = this.gapTo(this.toolManifold(tool), start, neighbours, options.searchMm);
    let found: Verified | null = null;
    let tilt: Path['tilt'] = null;
    let blockedBy: string[] = [];
    const tries: Path['tilt'][] = [
      null,
      ...options.tiltsDeg.flatMap((deg) => [
        { axis: 'x' as const, deg },
        { axis: 'x' as const, deg: -deg },
        { axis: 'z' as const, deg },
        { axis: 'z' as const, deg: -deg },
      ]),
    ];
    for (const candidate of tries) {
      const from =
        candidate === null ? start : tiltAbout(start, pivot, candidate.axis, candidate.deg);
      if (candidate !== null && !this.tiltIsFree(tool, start, pivot, candidate, bodies)) continue;
      for (const path of this.candidatePaths(tool, from, candidate, bodies, options)) {
        const verified = this.verify(tool, path, holder, neighbours, options);
        if (verified.ok) {
          found = verified;
          tilt = candidate;
          break;
        }
        if (blockedBy.length === 0) blockedBy = verified.blockedBy;
      }
      if (found !== null) break;
    }
    return this.report(input, options, found, tilt, neighbourGap, blockedBy, bodies);
  }

  /** Free paths on the rasters from `from`, cheapest first: lift only, or a short lift then a pull. */
  private candidatePaths(
    tool: ToolBody,
    from: Pose,
    tilt: Path['tilt'],
    bodies: readonly SolidBody[],
    options: RemovalOptions,
  ): Path[] {
    const out: Path[] = [];
    const holder = bodies[0];
    if (holder === undefined) return out;
    const yTool = rasterize(tool.mesh, from.rotation, [0, 0, 0], CELL_MM);
    const di = Math.round(from.position[0] / CELL_MM);
    const dj = Math.round(from.position[2] / CELL_MM);
    const rise = riseLimit(
      yTool,
      bodies.map((b) => b.grid(CELL_MM)),
      di,
      dj,
      from.position[1],
    );
    if (!Number.isFinite(rise)) {
      out.push({
        liftMm: clearance(holder.grid(CELL_MM), yTool, di, dj, from.position[1]),
        pullMm: 0,
        from,
        tilt,
      });
    }
    // Pulls: with +Z "up" for the rasters, a lift of h moves the tool along the grid's depth axis.
    const zTool = rasterize(tool.mesh, multiply(Z_UP, from.rotation), [0, 0, 0], CELL_MM);
    const zGrids = bodies.map((b) => zGridOf(b));
    const zi = Math.round(from.position[0] / CELL_MM);
    for (const lift of [0, ...options.shortLiftsMm]) {
      if (lift > 0 && lift > rise) break;
      const zj = Math.round(-(from.position[1] + lift) / CELL_MM);
      if (Number.isFinite(riseLimit(zTool, zGrids, zi, zj, from.position[2]))) continue;
      const holderZ = zGrids[0];
      out.push({
        liftMm: lift,
        pullMm: holderZ === undefined ? 0 : clearance(holderZ, zTool, zi, zj, from.position[2]),
        from,
        tilt,
      });
      break;
    }
    return out.sort((a, b) => a.liftMm + a.pullMm - (b.liftMm + b.pullMm));
  }

  /** Is turning the tool by the tilt (in steps) free of the obstacles? */
  private tiltIsFree(
    tool: ToolBody,
    start: Pose,
    pivot: Vec3,
    tilt: { axis: 'x' | 'z'; deg: number },
    bodies: readonly SolidBody[],
  ): boolean {
    const grids = bodies.map((b) => b.grid(CELL_MM));
    for (const f of [0.5, 1]) {
      const pose = tiltAbout(start, pivot, tilt.axis, tilt.deg * f);
      const grid = rasterize(tool.mesh, pose.rotation, [0, 0, 0], CELL_MM);
      const scan = scanAll(
        grid,
        grids,
        Math.round(pose.position[0] / CELL_MM),
        Math.round(pose.position[2] / CELL_MM),
        pose.position[1],
      );
      if (scan.penetrationMm > 1.5 || grid.min[2] + pose.position[2] < -0.5) return false;
    }
    return true;
  }

  /** Walks the path with exact booleans; measures the clearance to neighbours on the way. */
  private verify(
    tool: ToolBody,
    path: Path,
    holder: SolidBody,
    neighbours: readonly SolidBody[],
    options: RemovalOptions,
  ): Verified {
    const toolSolid = this.toolManifold(tool);
    const solids = [
      { id: holder.id, body: holder, solid: this.bodyManifold(holder), baseline: 0 },
      ...neighbours.map((n) => ({ id: n.id, body: n, solid: this.bodyManifold(n), baseline: 0 })),
      { id: 'board', body: null, solid: this.wallManifold(), baseline: 0 },
    ];
    for (const s of solids) s.baseline = this.overlap(toolSolid, path.from, s.solid);
    let clearance = options.searchMm;
    const poses: Pose[] = [];
    const total = path.liftMm + path.pullMm;
    const steps = Math.max(1, Math.ceil(total / VERIFY_STEP_MM));
    for (let s = 0; s <= steps; s++) {
      const d = (s / steps) * total;
      const lift = Math.min(d, path.liftMm);
      const pull = Math.max(0, d - path.liftMm);
      poses.push({
        rotation: path.from.rotation,
        position: [
          path.from.position[0],
          path.from.position[1] + lift,
          path.from.position[2] + pull,
        ],
      });
    }
    for (const pose of poses) {
      const posed = toolSolid.transform(matrixOf(pose));
      try {
        for (const s of solids) {
          const gap = posed.minGap(s.solid, options.searchMm);
          if (s.body !== null && s.body !== holder) clearance = Math.min(clearance, gap);
          if (gap > TOUCH_MM) continue;
          const shared = posed.intersect(s.solid);
          const volume = shared.volume();
          shared.delete();
          if (volume > Math.max(OVERLAP_MM3, s.baseline * 1.5 + OVERLAP_MM3)) {
            return { ok: false, blockedBy: [s.id], path, clearanceMm: clearance };
          }
        }
      } finally {
        posed.delete();
      }
    }
    return { ok: true, blockedBy: [], path, clearanceMm: clearance };
  }

  private report(
    input: RemovalInput,
    options: RemovalOptions,
    found: Verified | null,
    tilt: Path['tilt'],
    neighbourGap: number,
    blockedBy: readonly string[],
    bodies: readonly SolidBody[],
  ): RemovalReport {
    const reasons: RemovalReason[] = [];
    if (found === null) {
      // Name what is in the way: the holder's own lips when nothing else is.
      const ids = blockedBy.length > 0 ? [...blockedBy] : bodies.map((b) => b.id).slice(0, 1);
      reasons.push({ code: 'blocked', params: { blockedBy: ids } });
      return {
        verdict: 'blocked',
        convenience: 0,
        clearanceMm: 0,
        neighbourGapMm: round1(neighbourGap),
        path: null,
        liftMm: 0,
        pullMm: 0,
        blockedBy: ids,
        reasons,
      };
    }
    const { path } = found;
    let verdict: RemovalVerdict = 'free';
    let convenience = 0.6 + 0.4 * clamp01(found.clearanceMm / 40);
    if (tilt !== null) {
      verdict = 'needs_tilt';
      convenience = Math.min(convenience, 0.5);
      reasons.push({ code: 'needs_tilt', params: { axis: tilt.axis, deg: Math.abs(tilt.deg) } });
    }
    const twoHands: RemovalReason[] = [];
    if (input.tool.massG > options.heavyG) {
      twoHands.push({
        code: 'heavy',
        params: { massG: Math.round(input.tool.massG), limitG: options.heavyG },
      });
    }
    if (neighbourGap < options.fingerRoomMm) {
      twoHands.push({
        code: 'cramped',
        params: { gapMm: round1(neighbourGap), neededMm: options.fingerRoomMm },
      });
    }
    if (path.liftMm > options.longLiftMm) {
      twoHands.push({
        code: 'long_lift',
        params: { liftMm: Math.round(path.liftMm), limitMm: options.longLiftMm },
      });
    }
    if (twoHands.length > 0) {
      verdict = 'needs_two_hands';
      convenience = Math.min(convenience, 0.3);
      reasons.push(...twoHands);
    } else if (found.clearanceMm < 4 && tilt === null) {
      reasons.push({ code: 'tight_clearance', params: { clearanceMm: round1(found.clearanceMm) } });
      convenience = Math.min(convenience, 0.7);
    }
    const motion =
      path.pullMm === 0
        ? 'lift'
        : path.liftMm === 0
          ? 'pull'
          : `lift ${Math.round(path.liftMm)} mm, pull`;
    const prefix =
      tilt === null ? '' : `tilt ${tilt.axis} ${tilt.deg > 0 ? '+' : ''}${tilt.deg} deg, `;
    return {
      verdict,
      convenience: Math.round(convenience * 100) / 100,
      clearanceMm: round1(found.clearanceMm),
      neighbourGapMm: round1(neighbourGap),
      path: prefix + motion,
      liftMm: Math.round(path.liftMm),
      pullMm: Math.round(path.pullMm),
      blockedBy: [],
      reasons,
    };
  }

  private gapTo(
    toolSolid: Manifold,
    pose: Pose,
    bodies: readonly SolidBody[],
    searchMm: number,
  ): number {
    const posed = toolSolid.transform(matrixOf(pose));
    let gap = searchMm;
    try {
      for (const b of bodies) gap = Math.min(gap, posed.minGap(this.bodyManifold(b), searchMm));
    } finally {
      posed.delete();
    }
    return gap;
  }

  private overlap(toolSolid: Manifold, pose: Pose, solid: Manifold): number {
    const posed = toolSolid.transform(matrixOf(pose));
    const shared = posed.intersect(solid);
    const volume = shared.volume();
    shared.delete();
    posed.delete();
    return volume;
  }

  private toolManifold(tool: ToolBody): Manifold {
    const cached = this.tools.get(tool);
    if (cached) return cached;
    const made = solidOf(this.wasm, tool.mesh.positions, tool.mesh.indices);
    this.tools.set(tool, made);
    return made;
  }

  private bodyManifold(body: SolidBody): Manifold {
    const cached = this.bodies.get(body);
    if (cached) return cached;
    const local = solidOf(this.wasm, body.mesh.positions, body.mesh.indices);
    const posed = local.transform(
      matrixOf({ rotation: body.rotation, position: body.translation }),
    );
    local.delete();
    this.bodies.set(body, posed);
    return posed;
  }

  /** The board and everything behind it: a slab at z < 0. */
  private wallManifold(): Manifold {
    if (this.wall) return this.wall;
    const cube = this.wasm.Manifold.cube([WALL_SIZE_MM, WALL_SIZE_MM, 200]);
    this.wall = cube.translate([-WALL_SIZE_MM / 2, -WALL_SIZE_MM / 2, -200]);
    cube.delete();
    return this.wall;
  }

  /** Frees the manifolds this probe still owns. */
  dispose(): void {
    this.wall?.delete();
    this.wall = null;
  }
}

interface Verified {
  ok: boolean;
  blockedBy: string[];
  path: Path;
  clearanceMm: number;
}

const zGridCache = new WeakMap<SolidBody, ColumnGrid>();

/** The body rasterised with +Z up (columns run along the wall normal). */
function zGridOf(body: SolidBody): ColumnGrid {
  let grid = zGridCache.get(body);
  if (grid === undefined) {
    grid = rasterize(
      body.mesh,
      multiply(Z_UP, body.rotation),
      apply(Z_UP, body.translation),
      CELL_MM,
    );
    zGridCache.set(body, grid);
  }
  return grid;
}

function solidOf(
  wasm: ManifoldToplevel,
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): Manifold {
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(positions),
    triVerts: Uint32Array.from(indices),
  });
  // Generators and GLB exporters duplicate vertices per face; welding makes the surface watertight.
  mesh.merge();
  const manifold = new wasm.Manifold(mesh);
  if (manifold.status() !== 'NoError') {
    manifold.delete();
    throw new Error('removal sweep: a body is not a closed solid');
  }
  return manifold;
}

function matrixOf(
  pose: Pose,
): [
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
] {
  const r = pose.rotation;
  return [
    r[0],
    r[3],
    r[6],
    0,
    r[1],
    r[4],
    r[7],
    0,
    r[2],
    r[5],
    r[8],
    0,
    pose.position[0],
    pose.position[1],
    pose.position[2],
    1,
  ];
}

function tiltAbout(pose: Pose, pivot: Vec3, axis: 'x' | 'z', deg: number): Pose {
  const turn = axis === 'x' ? rotationX(deg) : rotationZ(deg);
  const offset = apply(turn, [
    pose.position[0] - pivot[0],
    pose.position[1] - pivot[1],
    pose.position[2] - pivot[2],
  ]);
  return {
    rotation: multiply(turn, pose.rotation),
    position: [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]],
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * How far the tool must travel along the grid's up axis so that its lowest point is above the holder's highest
 * surface within the tool's footprint (plus the hold gap): the distance after which it has left the holder.
 */
function clearance(
  holder: ColumnGrid,
  tool: ColumnGrid,
  di: number,
  dj: number,
  y: number,
): number {
  const margin = 6;
  let top = -Infinity;
  for (let j = tool.j0 - margin; j < tool.j0 + tool.nz + margin; j++) {
    for (let i = tool.i0 - margin; i < tool.i0 + tool.nx + margin; i++) {
      const hi = i + di - holder.i0;
      const hj = j + dj - holder.j0;
      if (hi < 0 || hj < 0 || hi >= holder.nx || hj >= holder.nz) continue;
      const end = holder.offsets[hj * holder.nx + hi + 1] ?? 0;
      const begin = holder.offsets[hj * holder.nx + hi] ?? 0;
      if (end > begin) top = Math.max(top, holder.spans[2 * end - 1] ?? -Infinity);
    }
  }
  return Number.isFinite(top) ? Math.max(0, top - (tool.min[1] + y)) : 0;
}
