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
  type Bounds,
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
  /**
   * Smallest gap (mm) between the tool and a neighbour (not the holder, not the board) along the path; capped at `searchMm`. For a tool
   * cramped at rest (it needs two hands whatever the way) the way is not measured: this is then the rest gap, an upper bound.
   */
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
  /** Unit direction of the lift: straight up, or along the tool's own axis for a tool resting tilted in its slot. */
  dir: Vec3;
  /** The rasters found nothing in the way: tried before the candidates only the exact booleans can judge. */
  rasterClear: boolean;
  from: Pose;
  tilt: { axis: 'x' | 'z'; deg: number } | null;
}

/** Room above a tool, on top of one more tool length, that neighbours are collected in. */
const SWEEP_ABOVE_MM = 40;
/** How far in front of the holder a pulled tool's back goes before it counts as out. */
const FRONT_MARGIN_MM = 20;
const UP: Vec3 = [0, 1, 0];
/** Leaning less than this (degrees) is upright: straight up is the axis. */
const UPRIGHT_DEG = 0.5;
/** A lift along a leaning axis travels a little farther than straight up to leave the same hole (1 / cos of the lean, rounded up). */
const AXIS_STRETCH = 1.15;
const AXIS_EXTRA_MM = 5;
/** A tool leaning more than this does not come out along its axis: it lies in its holder rather than stands. */
const MAX_AXIS_LEAN_DEG = 25;
/** sin(MAX_AXIS_LEAN_DEG), rounded up: the sideways drift of a lift along a leaning axis per unit of way. */
const AXIS_DRIFT = 0.43;
const TOUCH_MM = 0.02;
/** A scrape of a few cubic millimetres (a shaft brushing the rim of its hole) is wiggled through by a hand; a real collision is tens. */
const OVERLAP_MM3 = 6;
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
    const height = bounds.max[1] - bounds.min[1];
    // The lift out of the holder is at most the holder's height above the tool's foot; along a leaning axis (up to
    // MAX_AXIS_LEAN_DEG) it drifts sideways by sin(lean) of that, which the neighbours collected must cover.
    const liftBound =
      Math.max(0, holder.bounds().max[1] - bounds.min[1]) * AXIS_STRETCH + AXIS_EXTRA_MM;
    const drift = 20 + AXIS_DRIFT * liftBound;
    const sweepBox = {
      min: [bounds.min[0] - drift, bounds.min[1] - 20, bounds.min[2] - drift] as Vec3,
      max: [
        bounds.max[0] + drift,
        bounds.max[1] + Math.max(height, liftBound) + SWEEP_ABOVE_MM,
        bounds.max[2] + 250 + drift,
      ] as Vec3,
    };
    const neighbours = input.neighbours.filter(
      (o) => o !== holder && boundsOverlap(sweepBox, o.bounds(), 0),
    );
    const bodies = [holder, ...neighbours];
    // The rasters only need what the tool can run into on the ways it is tried; the gaps and the exact sweep look at
    // everything within reach of the tool's real way (each culls by its own bounds), the sweep box or not.
    const everything = input.neighbours.filter((o) => o !== holder);
    const start: Pose = { rotation: placement.rotation, position: placement.position };
    const pivot = input.pivot ?? placement.position;

    const neighbourGap = this.gapTo(
      this.toolManifold(tool),
      start,
      tool,
      everything,
      options.fingerRoomMm,
      options.searchMm,
    );
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
        const verified = this.verify(tool, path, holder, everything, options, neighbourGap);
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
    // What is above the tool, holder aside: the tool sits in the holder's own hole or slot, and the rasters cannot tell that
    // wall from a lid (a rasterised shaft overlaps its rasterised hole by a cell). The exact sweep follows the lift up to
    // the top of the holder's footprint, so a holder with a lid is still caught there.
    const rise = riseLimit(
      yTool,
      bodies.slice(1).map((b) => b.grid(CELL_MM)),
      di,
      dj,
      from.position[1],
    );
    // Straight up, and for a tool resting tilted in its slot along its own axis. The raster is conservative where a tool
    // touches a wall (a rasterised shaft overlaps the rasterised hole by a cell), so a way out it calls blocked is still
    // tried: the exact booleans of `verify` decide, the raster only orders the candidates. Such a way is a short lift
    // out of the holder and then a pull forward (a tool is not lifted a whole tool length: the row above is in the way
    // of that long before it matters), verified through its whole length.
    const rasterClear = !Number.isFinite(rise);
    const liftMm = clearance(holder.grid(CELL_MM), yTool, di, dj, from.position[1]);
    const pullOutMm = Math.max(
      0,
      holder.bounds().max[2] - (from.position[2] + yTool.min[2]) + FRONT_MARGIN_MM,
    );
    out.push({ liftMm, pullMm: rasterClear ? 0 : pullOutMm, dir: UP, from, tilt, rasterClear });
    const axis = upAlongAxis(from.rotation);
    if (axis !== null) {
      out.push({
        liftMm: liftMm * AXIS_STRETCH + AXIS_EXTRA_MM,
        pullMm: rasterClear ? 0 : pullOutMm,
        dir: axis,
        from,
        tilt,
        rasterClear: false,
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
        dir: UP,
        pullMm: holderZ === undefined ? 0 : clearance(holderZ, zTool, zi, zj, from.position[2]),
        from,
        tilt,
        rasterClear: true,
      });
      break;
    }
    return out.sort(
      (a, b) =>
        Number(b.rasterClear) - Number(a.rasterClear) ||
        a.liftMm + a.pullMm - (b.liftMm + b.pullMm),
    );
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
    neighbourGap: number,
  ): Verified {
    const toolSolid = this.toolManifold(tool);
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
          path.from.position[0] + path.dir[0] * lift,
          path.from.position[1] + path.dir[1] * lift,
          path.from.position[2] + path.dir[2] * lift + pull,
        ],
      });
    }
    // The rotation is the same all the way: the tool's bounds at any pose are its bounds at the start, moved.
    const base = worldBounds(tool, path.from);
    const boundsAt = (pose: Pose): Bounds => shifted(base, pose.position, path.from.position);
    // Only what the tool's whole way (its bounds at both ends, and what lies between) comes near is worth a boolean.
    let way: Bounds = base;
    for (const pose of poses) way = union(way, boundsAt(pose));
    way = grown(way, options.searchMm);
    const solids: Sweep[] = [
      { id: holder.id, counts: false, bounds: holder.bounds(), solid: this.bodyManifold(holder) },
      ...neighbours
        .filter((n) => boundsOverlap(way, n.bounds(), 0))
        .map((n) => ({
          id: n.id,
          counts: true,
          bounds: n.bounds(),
          solid: this.bodyManifold(n),
        })),
      { id: 'board', counts: false, bounds: BOARD_BOUNDS, solid: this.wallManifold() },
    ];
    const baselines = solids.map((s) => this.overlap(toolSolid, path.from, s.solid));
    // A tool with less than room for fingers beside it at rest needs two hands whatever the clearance along the way, and its
    // rating is capped by that: the way is not measured, the rest gap stands for it (an upper bound).
    const measured = neighbourGap >= options.fingerRoomMm;
    let clearance = measured ? options.searchMm : neighbourGap;
    for (const pose of poses) {
      const near = boundsAt(pose);
      // Nothing is measured farther away than it could matter: a box gap is never more than the true gap, so a solid whose
      // box is at least as far as the closest one so far cannot lower the clearance, and one whose box is not touching the
      // tool's box cannot overlap it.
      const close = solids.filter(
        (s) =>
          boundsGap(near, s.bounds) <= TOUCH_MM ||
          (measured && s.counts && boundsGap(near, s.bounds) < clearance),
      );
      if (close.length === 0) continue;
      const posed = toolSolid.transform(matrixOf(pose));
      try {
        for (const s of close) {
          const apart = boundsGap(near, s.bounds);
          // The gap is looked for no farther than the closest neighbour seen so far: a smaller search is a cheaper one.
          if (measured && s.counts && apart < clearance && clearance > TOUCH_MM) {
            clearance = Math.min(clearance, posed.minGap(s.solid, clearance));
          }
          if (apart > TOUCH_MM) continue;
          const shared = posed.intersect(s.solid);
          const volume = shared.volume();
          shared.delete();
          const baseline = baselines[solids.indexOf(s)] ?? 0;
          if (volume > Math.max(OVERLAP_MM3, baseline * 1.5 + OVERLAP_MM3)) {
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
    tool: ToolBody,
    bodies: readonly SolidBody[],
    fingerRoomMm: number,
    searchMm: number,
  ): number {
    const near = worldBounds(tool, pose);
    // Closest boxes first: a near neighbour narrows the search for all the farther ones.
    const ordered = bodies
      .map((b) => ({ body: b, apart: boundsGap(near, b.bounds()) }))
      .filter((e) => e.apart < searchMm)
      .sort((a, b) => a.apart - b.apart);
    if (ordered.length === 0) return searchMm;
    const posed = toolSolid.transform(matrixOf(pose));
    let gap = searchMm;
    try {
      // Room for fingers decides most: look for a gap smaller than that first (a cheap search), and only when there is
      // none for the whole gap (an expensive one). A search that finds nothing within its limit says only "farther".
      for (const { body, apart } of ordered) {
        if (apart >= fingerRoomMm) break;
        const found = posed.minGap(this.bodyManifold(body), fingerRoomMm);
        if (found < fingerRoomMm) gap = Math.min(gap, found);
      }
      if (gap >= fingerRoomMm) {
        for (const { body, apart } of ordered) {
          if (apart >= gap) continue;
          gap = Math.min(gap, posed.minGap(this.bodyManifold(body), gap));
        }
      }
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

/** The tool's own axis pointing up, or null when it is vertical already (or lies sideways: no way out along it). */
function upAlongAxis(rotation: Mat3): Vec3 | null {
  const axis = apply(rotation, UP);
  const up: Vec3 = axis[1] >= 0 ? axis : [-axis[0], -axis[1], -axis[2]];
  const lean = (Math.acos(Math.min(1, up[1])) * 180) / Math.PI;
  return lean < UPRIGHT_DEG || lean > MAX_AXIS_LEAN_DEG ? null : up;
}

/** A solid the sweep tests the tool against: `counts` = a neighbour whose gap is the path's clearance (not the holder, not the board). */
interface Sweep {
  id: string;
  counts: boolean;
  bounds: Bounds;
  solid: Manifold;
}

const BOARD_BOUNDS: Bounds = {
  min: [-WALL_SIZE_MM / 2, -WALL_SIZE_MM / 2, -200],
  max: [WALL_SIZE_MM / 2, WALL_SIZE_MM / 2, 0],
};

function shifted(bounds: Bounds, to: Vec3, from: Vec3): Bounds {
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return {
    min: [bounds.min[0] + d[0], bounds.min[1] + d[1], bounds.min[2] + d[2]],
    max: [bounds.max[0] + d[0], bounds.max[1] + d[1], bounds.max[2] + d[2]],
  };
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

function grown(a: Bounds, mm: number): Bounds {
  return {
    min: [a.min[0] - mm, a.min[1] - mm, a.min[2] - mm],
    max: [a.max[0] + mm, a.max[1] + mm, a.max[2] + mm],
  };
}

/** Distance between two boxes (0 when they overlap): never more than the distance between what is inside them. */
function boundsGap(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]);
  const dy = Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]);
  const dz = Math.max(0, a.min[2] - b.max[2], b.min[2] - a.max[2]);
  return Math.hypot(dx, dy, dz);
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
