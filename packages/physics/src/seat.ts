/**
 * Seating: where a tool really ends up in a holder. The tool is lowered from above in every sensible orientation
 * (tip down or up, four quarter turns about its own axis) and at every lateral position of the slot window until
 * it touches something (gravity settle against the real holder mesh); of the positions that rest on something the
 * lowest centre of gravity wins (the tool falls as deep as the slot lets it), then the best of the lowest few by
 * hang stability. So a shaft ends up inside the slot or hole, a head on the prongs of a fork, a tool in the tray
 * floor, never on top of the holder.
 */
import {
  apply,
  matrixToEuler,
  type Mat3,
  multiply,
  roundTo,
  rotationY,
  rotationZ,
  type Vec3,
} from '@hsw-editor/compat';
import type { Pose } from '@hsw-editor/core';
import { CELL_MM, type Bounds, type Placement, type SolidBody, type ToolBody } from './body.ts';
import { rasterize, spanRange, topOf, type ColumnGrid } from './columns.ts';
import { analyseHangPose, type HangOptions, type HangReport } from './hang.ts';
import { measureSeatFit, WEDGED_MIN_MM } from './seatFit.ts';
import { scanAll, settle, settleBelow } from './settle.ts';

export interface SeatRequest {
  tool: ToolBody;
  holder: SolidBody;
  /** Everything else the tool could touch: neighbouring holders and tools, shelves. */
  neighbours: readonly SolidBody[];
  /** Slot position in the wall frame: x centre of the slot, z centre of the holder. */
  anchor: Vec3;
  /** Lateral search window around the anchor along x, mm. */
  halfWidthMm: number;
  /** The tool's working end points down in this holder (screwdrivers, pliers, knives). */
  tipDown: boolean;
  options?: Partial<HangOptions>;
}

export interface SeatResult {
  placement: Placement;
  pose: Pose;
  report: HangReport;
  /** How many (orientation, position) settles were tried. */
  candidates: number;
}

interface Candidate {
  rotation: Mat3;
  /** Euler angles of `rotation` as the wall item stores them. */
  angles: { rotX: number; rotY: number; rotZ: number };
  /** The class's natural end down / up and facing front (the seat is not an alternative the user has to accept). */
  natural: boolean;
  /** Tool origin on the world grid, mm. */
  x: number;
  z: number;
  y: number;
  comY: number;
}

interface Orientation {
  quarterTurns: number;
  flipped: boolean;
  rotation: Mat3;
}

/** Evaluations per orientation in the lattice pass; the lattice step grows for roomy cavities. */
const LATTICE_BUDGET = 1200;
const X_PENALTY_PER_MM = 0.01;
const TOP_CANDIDATES = 3;
/** Obstacles that must be clear at the start of a lowering: the holder alone (it is `obstacles[0]`). */
const HOLDER_ONLY = 1;
/** Centre-of-gravity height (mm) a seat is charged per mm it ends up inside a neighbour. */
const NEIGHBOUR_OVERLAP_MM_PER_MM = 6;
/** Centre-of-gravity height (mm) a seat is allowed to lose to keep the class's natural end down / up and the tool facing front. */
const UNPREFERRED_FLIP_MM = 30;
/** Facing penalty per quarter turn about the axis: a tool faces front unless the slot demands otherwise. */
const QUARTER_TURN_MM: readonly number[] = [0, 15, 8, 15];
/** Centre-of-gravity height (mm) a fully unstable seat is charged: a lower seat that is less stable loses to a higher stable one. */
const UNSTABLE_COST_MM = 150;
/** A natural seat below this score cannot be held: it gives way to the other end whenever that one is clearly better. */
const NATURAL_CANNOT_BE_HELD_BELOW = 0.5;
/** A natural seat below this score is held but not solidly (a wrench stood on prongs it only tips on): it gives way to the other end when that one is stable and clearly better. */
const NATURAL_FAILS_BELOW = 0.8;
/** Shares of the holder depth at which a tool's hole is tried over a peg (clear of the back plate, its gusset and the end flange). */
const HOLE_DEPTH_FRACTIONS: readonly number[] = [0.3, 0.4, 0.5, 0.6, 0.7];

/** Centre-of-gravity height (mm) a seat is charged for a tool stuck in an opening instead of resting (wedged: a flared tip in a small hole). */
const WEDGED_COST_MM = 120;
/** Centre-of-gravity height (mm) a seat is charged for reaching out below a rack that is too shallow for the tool. */
const PROTRUDES_COST_MM = 60;

/** A holder column this much below the holder's rim counts as part of a cavity. */
const CAVITY_DEPTH_MM = 3;

/** Orientation set of a slot insertion: the preferred end first, then four quarter turns about the axis. */
export function slotOrientations(tipDown: boolean): Orientation[] {
  const out: Orientation[] = [];
  for (const flipped of [tipDown, !tipDown]) {
    for (let quarterTurns = 0; quarterTurns < 4; quarterTurns++) {
      out.push({
        quarterTurns,
        flipped,
        rotation: multiply(rotationY(90 * quarterTurns), rotationZ(flipped ? 180 : 0)),
      });
    }
  }
  return out;
}

function poseOf(angles: Candidate['angles'], position: Vec3): Pose {
  return {
    x: roundTo(position[0], 3),
    y: roundTo(position[1], 3),
    z: roundTo(position[2], 3),
    ...angles,
  };
}

interface Window {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** Lowest-centre-of-gravity resting position over the lateral window for one orientation. */
function searchOrientation(
  request: SeatRequest,
  orientation: Orientation,
  window: Window,
  obstacles: readonly SolidBody[],
): { best: Candidate | null; tried: number } {
  const cellMm = CELL_MM;
  const tool = rasterize(request.tool.mesh, orientation.rotation, [0, 0, 0], cellMm);
  if (tool.nx === 0) return { best: null, tried: 0 };
  const grids: ColumnGrid[] = obstacles.map((o) => o.grid(cellMm));
  const holderGrid = request.holder.grid(cellMm);
  const rim = holderGrid.max[1];
  const comLocalY = apply(orientation.rotation, request.tool.comMm)[1];
  // The tool is lowered into the holder from above its own rim; whatever else hangs over that spot (another tool, the
  // holder of a row above) is not a floor it could land on.
  const startY = rim - tool.min[1] + 2;

  const iFrom = Math.ceil(window.x0 / cellMm);
  const iTo = Math.floor(window.x1 / cellMm);
  const jFrom = Math.max(Math.ceil(window.z0 / cellMm), Math.ceil(-tool.min[2] / cellMm));
  const jTo = Math.floor(window.z1 / cellMm);
  const hb = request.holder.bounds();
  const range: CellRange = { iFrom, iTo, jFrom, jTo };
  const { inCavity, useCavity, step } = latticeOf(holderGrid, hb, rim, range);

  let tried = 0;
  let best: Candidate | null = null;
  const evaluate = (di: number, dj: number): void => {
    if (dj * cellMm + tool.min[2] < -0.01) return;
    tried++;
    const x = di * cellMm;
    const extra =
      comLocalY +
      Math.abs(x - request.anchor[0]) * X_PENALTY_PER_MM +
      (orientation.flipped === request.tipDown ? 0 : UNPREFERRED_FLIP_MM) +
      (QUARTER_TURN_MM[orientation.quarterTurns] ?? 0);
    const rest = restCost(
      { request, tool, grids, holderGrid, hb, startY },
      di,
      dj,
      (best === null ? Infinity : best.comY) - extra,
      best === null ? null : best.comY,
      extra,
    );
    if (rest === null) return;
    if (best === null || rest.comY < best.comY) {
      best = {
        rotation: orientation.rotation,
        angles: {
          rotX: 0,
          rotY: (90 * orientation.quarterTurns) % 360,
          rotZ: orientation.flipped ? 180 : 0,
        },
        natural: orientation.flipped === request.tipDown,
        x,
        z: dj * cellMm,
        y: rest.y,
        comY: rest.comY,
      };
    }
  };
  sweepLattice(range, step, useCavity ? inCavity : null, evaluate);
  const coarseBest = best as Candidate | null;
  if (coarseBest !== null && step > 1) {
    refineAround(range, step, coarseBest, evaluate);
  }
  return { best, tried };
}

/** Evaluates every `step`-th cell of the range (only cavity cells when `inCavity` is given). */
function sweepLattice(
  { iFrom, iTo, jFrom, jTo }: CellRange,
  step: number,
  inCavity: ((di: number, dj: number) => boolean) | null,
  evaluate: (di: number, dj: number) => void,
): void {
  for (let dj = jFrom; dj <= jTo; dj += step) {
    for (let di = iFrom; di <= iTo; di += step) {
      if (inCavity !== null && !inCavity(di, dj)) continue;
      evaluate(di, dj);
    }
  }
}

/** Evaluates every cell within `step` of the coarse winner that lies in the range. */
function refineAround(
  { iFrom, iTo, jFrom, jTo }: CellRange,
  step: number,
  coarseBest: Candidate,
  evaluate: (di: number, dj: number) => void,
): void {
  const ci = Math.round(coarseBest.x / CELL_MM);
  const cj = Math.round(coarseBest.z / CELL_MM);
  for (let dj = cj - step; dj <= cj + step; dj++) {
    for (let di = ci - step; di <= ci + step; di++) {
      if (di >= iFrom && di <= iTo && dj >= jFrom && dj <= jTo) evaluate(di, dj);
    }
  }
}

interface CellRange {
  iFrom: number;
  iTo: number;
  jFrom: number;
  jTo: number;
}

/** Which window cells lie in a cavity of the holder (a slot, a pocket, a fork gap; everything when it has none) and the lattice step. */
function latticeOf(
  holderGrid: ColumnGrid,
  hb: Bounds,
  rim: number,
  { iFrom, iTo, jFrom, jTo }: CellRange,
): { inCavity: (di: number, dj: number) => boolean; useCavity: boolean; step: number } {
  const inCavity = (di: number, dj: number): boolean => {
    const x = di * CELL_MM;
    const z = dj * CELL_MM;
    if (x < hb.min[0] || x > hb.max[0] || z < hb.min[2] || z > hb.max[2]) return false;
    return topOf(holderGrid, di, dj) < rim - CAVITY_DEPTH_MM;
  };
  let cavityCells = 0;
  for (let dj = jFrom; dj <= jTo; dj++)
    for (let di = iFrom; di <= iTo; di++) if (inCavity(di, dj)) cavityCells++;
  const useCavity = cavityCells > 0;
  const cells = useCavity ? cavityCells : (iTo - iFrom + 1) * (jTo - jFrom + 1);
  const step = Math.max(1, Math.ceil(Math.sqrt(cells / LATTICE_BUDGET)));
  return { inCavity, useCavity, step };
}

interface RestContext {
  request: SeatRequest;
  tool: ColumnGrid;
  grids: readonly ColumnGrid[];
  holderGrid: ColumnGrid;
  hb: Bounds;
  startY: number;
}

/**
 * Where the tool comes to rest above lattice cell (di, dj) and what that costs (centre of gravity plus penalties, `extra`
 * included); null when it has no clean rest there. `bestComY` is the best cost so far (null when none).
 */
function restCost(
  ctx: RestContext,
  di: number,
  dj: number,
  floor: number,
  bestComY: number | null,
  extra: number,
): { y: number; comY: number } | null {
  const { request, tool, grids, holderGrid, hb, startY } = ctx;
  const s = settleBelow(tool, grids, di, dj, startY, floor, HOLDER_ONLY);
  if (s === null || s.startPenetrationMm > 0.01 || !Number.isFinite(s.y)) return null;
  // A position that ends inside a neighbour (a handle poking over the slot) loses to a clean one beside it, even when
  // both fall to the same floor: the overlap counts against the seat like a taller centre of gravity.
  const overlap =
    grids.length > HOLDER_ONLY
      ? scanAll(tool, grids.slice(HOLDER_ONLY), di, dj, s.y).penetrationMm
      : 0;
  let comY = s.y + extra + overlap * NEIGHBOUR_OVERLAP_MM_PER_MM;
  // The lowest rest is not the best one when the tool only got there by jamming: charge a wedge or a reach out of the rack
  // like a taller centre of gravity, so the position beside the hole, the shaft right through it or the handle on the rim wins.
  // Only a position that could still win is measured (the fit reads every column of the tool).
  if (bestComY === null || comY < bestComY) {
    const limit = request.options?.protrudeLimitMm;
    const fit = measureSeatFit({ grid: tool, di, dj, y: s.y }, holderGrid, hb, limit !== undefined);
    if (fit.wedgedMm >= WEDGED_MIN_MM) comY += WEDGED_COST_MM;
    if (limit !== undefined && fit.protrudeMm > limit) comY += PROTRUDES_COST_MM;
  }
  return { y: s.y, comY };
}

export function seatTool(request: SeatRequest): SeatResult | null {
  const { holder, anchor } = request;
  const hb = holder.bounds();
  const obstacles = [holder, ...request.neighbours.filter((o) => o !== holder)];
  const window: Window = {
    x0: anchor[0] - request.halfWidthMm,
    x1: anchor[0] + request.halfWidthMm,
    z0: hb.min[2],
    z1: hb.max[2],
  };
  let tried = 0;
  const found: Candidate[] = [];
  for (const orientation of slotOrientations(request.tipDown)) {
    const r = searchOrientation(request, orientation, window, obstacles);
    tried += r.tried;
    if (r.best) found.push(r.best);
  }
  found.push(...seatByHole(request, obstacles));
  found.sort((a, b) => a.comY - b.comY);
  if (found.length === 0) return null;
  const natural = found.filter((c) => c.natural);
  const alternative = found.filter((c) => !c.natural);
  const bestNatural = evaluateBest(request, natural.slice(0, TOP_CANDIDATES), obstacles, tried);
  const bestAlternative = evaluateBest(request, alternative.slice(0, 2), obstacles, tried);
  if (bestNatural === null) return bestAlternative;
  // The class's natural end first. The other way up when the natural one cannot be held and the other is clearly better; and
  // when the natural one is held but not solidly (below NATURAL_FAILS_BELOW) only for an end that is solid.
  if (bestAlternative === null || bestAlternative.report.score <= bestNatural.report.score + 0.3) {
    return bestNatural;
  }
  const naturalScore = bestNatural.report.score;
  const flips =
    naturalScore < NATURAL_CANNOT_BE_HELD_BELOW ||
    (naturalScore < NATURAL_FAILS_BELOW && bestAlternative.report.status === 'stable');
  return flips ? bestAlternative : bestNatural;
}

function evaluateBest(
  request: SeatRequest,
  candidates: readonly Candidate[],
  obstacles: readonly SolidBody[],
  tried: number,
): SeatResult | null {
  let winner: SeatResult | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    const placement: Placement = { rotation: c.rotation, position: [c.x, c.y, c.z] };
    const report = analyseHangPose({
      tool: request.tool,
      placement,
      obstacles,
      holder: request.holder,
      leanBack: true,
      ...(request.options ? { options: request.options } : {}),
    });
    const cost = c.comY + (1 - report.score) * UNSTABLE_COST_MM;
    if (winner === null || cost < bestCost) {
      bestCost = cost;
      // A tool that leans against the slot walls rests tilted: the seat is that pose.
      const rest = report.rest?.placement;
      const pose = rest
        ? poseOf(matrixToEuler(rest.rotation), rest.position)
        : poseOf(c.angles, [c.x, c.y, c.z]);
      winner = { placement: rest ?? placement, pose, report, candidates: tried };
    }
  }
  return winner;
}

/** Material of the holder in the x-y plane through z = `z`, as occupied cells of `cellMm` (a slice of the column grid). */
function sliceCells(
  holder: SolidBody,
  z: number,
): { x0: number; y0: number; w: number; h: number; solid: Uint8Array } {
  const grid = holder.grid(CELL_MM);
  const b = holder.bounds();
  const x0 = Math.floor(b.min[0] / CELL_MM);
  const y0 = Math.floor(b.min[1] / CELL_MM);
  const w = Math.ceil((b.max[0] - b.min[0]) / CELL_MM) + 1;
  const h = Math.ceil((b.max[1] - b.min[1]) / CELL_MM) + 1;
  const solid = new Uint8Array(w * h);
  const j = Math.floor(z / CELL_MM);
  for (let i = 0; i < w; i++) {
    const [s0, s1] = spanRange(grid, x0 + i, j);
    for (let s = s0; s < s1; s++) {
      const from = Math.max(0, Math.floor((grid.spans[2 * s] ?? 0) / CELL_MM) - y0);
      const to = Math.min(h - 1, Math.floor((grid.spans[2 * s + 1] ?? 0) / CELL_MM) - y0);
      for (let y = from; y <= to; y++) solid[y * w + i] = 1;
    }
  }
  return { x0, y0, w, h, solid };
}

/** Centres of the free-standing rods (pegs, hooks, spindles) of the holder at depth `z`: connected material blobs narrower than `maxWidthMm`. */
export function findPegs(holder: SolidBody, z: number, maxWidthMm: number): Vec3[] {
  const { x0, y0, w, h, solid } = sliceCells(holder, z);
  const seen = new Uint8Array(w * h);
  const out: Vec3[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!solid[start] || seen[start]) continue;
    const { minI, maxI, minJ, maxJ } = floodBlob(solid, seen, w, h, start);
    const width = (maxI - minI + 1) * CELL_MM;
    const height = (maxJ - minJ + 1) * CELL_MM;
    if (width <= maxWidthMm && height <= maxWidthMm) {
      out.push([(x0 + (minI + maxI + 1) / 2) * CELL_MM, (y0 + (minJ + maxJ + 1) / 2) * CELL_MM, z]);
    }
  }
  return out;
}

/** Marks the blob of solid cells connected to `start` as seen and returns its cell-index bounds. */
function floodBlob(
  solid: Uint8Array,
  seen: Uint8Array,
  w: number,
  h: number,
  start: number,
): { minI: number; maxI: number; minJ: number; maxJ: number } {
  const stack = [start];
  seen[start] = 1;
  let minI = w;
  let maxI = 0;
  let minJ = h;
  let maxJ = 0;
  while (stack.length > 0) {
    const c = stack.pop() as number;
    const i = c % w;
    const j = (c - i) / w;
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    minJ = Math.min(minJ, j);
    maxJ = Math.max(maxJ, j);
    for (const n of [c - 1, c + 1, c - w, c + w]) {
      if (n < 0 || n >= w * h || seen[n] || !solid[n]) continue;
      if ((n === c - 1 && i === 0) || (n === c + 1 && i === w - 1)) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return { minI, maxI, minJ, maxJ };
}

/** Seats by a hole or loop of the tool onto a rod of the holder: the hole is lowered over the rod until its top rests on it. */
function seatByHole(request: SeatRequest, obstacles: readonly SolidBody[]): Candidate[] {
  const hang = request.tool.hang;
  const diameter = hang?.diameterMm;
  if (
    !hang ||
    (hang.kind !== 'hole' && hang.kind !== 'loop') ||
    diameter === undefined ||
    diameter < 4
  )
    return [];
  const radius = diameter / 2;
  const hb = request.holder.bounds();
  const angles = holeAngles(request.tool.comMm, hang.point);
  const grids = obstacles.map((o) => o.grid(CELL_MM));
  const out: Candidate[] = [];
  for (const fraction of HOLE_DEPTH_FRACTIONS) {
    const z0 = hb.min[2] + fraction * (hb.max[2] - hb.min[2]);
    for (const peg of findPegs(request.holder, z0, 2 * radius - 2)) {
      for (const deg of angles) {
        const c = seatOnPeg(request, grids, hang.point, peg, deg, fraction);
        if (c !== null) out.push(c);
      }
    }
  }
  return out;
}

/** Rotations about z (degrees) to try for a hole: around the hanging equilibrium, or both ways up when it has none. */
function holeAngles(com: Vec3, hangPoint: Vec3): number[] {
  const [vx, vy] = [com[0] - hangPoint[0], com[1] - hangPoint[1]];
  const angles: number[] = [];
  if (Math.hypot(vx, vy) >= 3) {
    const eq = -90 - (Math.atan2(vy, vx) * 180) / Math.PI;
    for (const d of [-5, -2.5, 0, 2.5, 5]) angles.push(eq + d);
  } else {
    angles.push(0, 180);
  }
  return angles;
}

/** The tool hung by its hole on `peg` at rotation `deg`, or null when it does not rest there cleanly. */
function seatOnPeg(
  request: SeatRequest,
  grids: readonly ColumnGrid[],
  hangPoint: Vec3,
  peg: Vec3,
  deg: number,
  fraction: number,
): Candidate | null {
  const rotation = rotationZ(deg);
  const h = apply(rotation, hangPoint);
  const di = Math.round((peg[0] - h[0]) / CELL_MM);
  const dj = Math.round((peg[2] - h[2]) / CELL_MM);
  const startY = peg[1] - h[1];
  const tool = rasterize(request.tool.mesh, rotation, [0, 0, 0], CELL_MM);
  if (tool.nx === 0 || dj * CELL_MM + tool.min[2] < -0.01) return null;
  const s = settle(tool, grids, di, dj, startY, HOLDER_ONLY);
  if (s.startPenetrationMm > 0.05 || !Number.isFinite(s.y)) return null;
  // Ties (every depth along a plain rod rests alike) go to the middle of the rod; a hang inside a neighbour is charged
  // like a slot seat is.
  const overlap =
    grids.length > HOLDER_ONLY
      ? scanAll(tool, grids.slice(HOLDER_ONLY), di, dj, s.y).penetrationMm
      : 0;
  const comY =
    s.y +
    apply(rotation, request.tool.comMm)[1] +
    Math.abs(fraction - 0.5) * 0.2 +
    overlap * NEIGHBOUR_OVERLAP_MM_PER_MM;
  return {
    rotation,
    angles: { rotX: 0, rotY: 0, rotZ: ((deg % 360) + 360) % 360 },
    natural: true,
    x: di * CELL_MM,
    z: dj * CELL_MM,
    y: s.y,
    comY,
  };
}
