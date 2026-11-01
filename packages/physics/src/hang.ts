/**
 * Hang analysis of one tool in one pose: is it really supported (contact), does it stay there under a bump or a
 * pull, does it swing, is the holder strong enough. Gravity points along -Y; the wall is the plane z = 0 and the
 * tool must stay in front of it.
 */
import { apply, multiply, rotationX, rotationZ, type Vec3 } from '@hsw-editor/compat';
import {
  type Bounds,
  boundsOverlap,
  CELL_MM,
  centreOfGravity,
  type Placement,
  type SolidBody,
  type ToolBody,
  worldBounds,
} from './body.ts';
import { type ColumnGrid, rasterize } from './columns.ts';
import {
  DEFAULT_CONTACT_OPTIONS,
  type Contact,
  type ContactOptions,
  findContacts,
  type NamedGrid,
} from './contacts.ts';
import {
  DEFAULT_EQUILIBRIUM,
  DISTURBANCES,
  type DisturbanceName,
  type EquilibriumOptions,
  balances,
  marginAlong,
  reduceContacts,
} from './equilibrium.ts';
import { measureSeatFit, type SeatFit, WEDGED_MIN_MM } from './seatFit.ts';
import { scanAll } from './settle.ts';

export type HangReasonCode =
  | 'levitating'
  | 'penetrates'
  | 'falls'
  | 'tips'
  | 'swings'
  | 'slides_off'
  | 'needs_retention'
  | 'wedged'
  | 'protrudes'
  | 'overloaded';

export interface HangReason {
  code: HangReasonCode;
  params: Readonly<Record<string, number | string>>;
}

export type HangStatus = 'stable' | 'marginal' | 'unstable';

export interface HangReport {
  /** 0 (falls) .. 1 (solidly held). */
  score: number;
  status: HangStatus;
  reasons: HangReason[];
  /** Disturbance each direction withstands, in g (0 when gravity alone is not balanced). */
  marginsG: Record<DisturbanceName, number>;
  massG: number;
  /** Number of contact patches that carry the tool. */
  contactCount: number;
  /** Deepest interpenetration with an obstacle, mm. */
  penetrationMm: number;
  /** Swing of the centre of gravity under the reference bump, degrees (hinged tools only). */
  swingDeg: number | null;
  /**
   * Where the tool really comes to rest when the given pose is not in equilibrium but a small lean against the
   * holder walls makes it one; null when the given pose already is the rest pose (or nothing holds it).
   */
  rest: { placement: Placement; tiltDeg: number } | null;
}

export interface HangOptions {
  equilibrium: EquilibriumOptions;
  contact: ContactOptions;
  /** Lateral bump a tool must take without leaving its holder, in g (a shoulder brushing past). */
  bumpG: number;
  /** Outward pull a tool must take without walking out (another tool pulled off its neighbour), in g. */
  pullG: number;
  /** Interpenetration (mm) above which the tool is not seated but stuck inside the holder. */
  penetrationLimitMm: number;
  /** Largest mass (g) the mount carries; undefined = unchecked. */
  maxLoadG?: number | undefined;
  /** How far (mm) a tool may reach below the holder before the holder is too shallow for it; undefined = unchecked (racks that tools dangle from by design). */
  protrudeLimitMm?: number | undefined;
}

export const DEFAULT_HANG_OPTIONS: HangOptions = {
  equilibrium: DEFAULT_EQUILIBRIUM,
  contact: DEFAULT_CONTACT_OPTIONS,
  bumpG: 0.3,
  pullG: 0.15,
  penetrationLimitMm: 1.5,
};

/** Rasterises a tool at a placement; the sub-cell part of the position stays in the raster. */
export function toolGridAt(
  tool: ToolBody,
  placement: Placement,
): { grid: ColumnGrid; di: number; dj: number; y: number } {
  const di = Math.round(placement.position[0] / CELL_MM);
  const dj = Math.round(placement.position[2] / CELL_MM);
  const fx = placement.position[0] - di * CELL_MM;
  const fz = placement.position[2] - dj * CELL_MM;
  const grid = rasterize(tool.mesh, placement.rotation, [fx, 0, fz], CELL_MM);
  return { grid, di, dj, y: placement.position[1] };
}

/** Obstacles within this distance (mm) of the tool are scanned: far enough to measure how high a tool hovers. */
const NEARBY_MM = 60;

/** Obstacles near enough to matter for a tool at a placement. */
export function nearbyObstacles(
  toolBounds: Bounds,
  obstacles: readonly SolidBody[],
  marginMm = NEARBY_MM,
): NamedGrid[] {
  const out: NamedGrid[] = [];
  for (const body of obstacles) {
    if (boundsOverlap(toolBounds, body.bounds(), marginMm))
      out.push({ id: body.id, grid: body.grid() });
  }
  return out;
}

/**
 * The reference bump and pull are conventions, not cliffs: a hang that holds 0.29 g where 0.3 g is the reference is the same
 * hang, and friction alone often caps a margin just there. A margin of at least this factor times the reference is not reported.
 */
const REFERENCE_MARGIN_FACTOR = 0.9;

/** Widest contact band (mm) still treated as a line: the chord a round rod makes with a bigger round hole at the rest tolerance. */
const LINE_CONTACT_MM = 10;
/** How far (mm) the centre of gravity may sit off the vertical through a hinge and still hang in equilibrium. */
const HINGE_COM_OFFSET_MM = 8;
/** A contact that moves by more than this (mm per radian) along its normal under a turn about the hinge blocks the turn. */
const HINGE_BLOCK_MM = 6;
/** Sway of the centre of gravity (mm) under the reference bump from which a hinged tool is reported as swinging. */
const SWING_REPORT_MM = 20;

interface Hinge {
  /** Horizontal axis the tool can turn about (unit, in the wall frame). */
  axis: Vec3;
  /** A point of the contact line. */
  point: Vec3;
}

/**
 * Vertical contacts on one line (a peg, a hook, a ridge) leave the tool free to turn about it: a hinge, unless
 * another contact forbids that turn (a contact whose normal has a component along the motion of its point).
 */
function hingeOf(contacts: readonly Contact[]): Hinge | null {
  const vertical = contacts.filter((c) => c.kind === 'support' || c.kind === 'ceiling');
  if (vertical.length === 0) return null;
  // Principal directions of the contact points in the horizontal plane.
  let mx = 0;
  let mz = 0;
  for (const c of vertical) {
    mx += c.p[0];
    mz += c.p[2];
  }
  mx /= vertical.length;
  mz /= vertical.length;
  let sxx = 0;
  let szz = 0;
  let sxz = 0;
  for (const c of vertical) {
    const dx = c.p[0] - mx;
    const dz = c.p[2] - mz;
    sxx += dx * dx;
    szz += dz * dz;
    sxz += dx * dz;
  }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const major: Vec3 = [Math.cos(theta), 0, Math.sin(theta)];
  const minor: Vec3 = [-Math.sin(theta), 0, Math.cos(theta)];
  let minorSpread = 0;
  for (const c of vertical) {
    const along = Math.abs((c.p[0] - mx) * minor[0] + (c.p[2] - mz) * minor[2]);
    if (along > minorSpread) minorSpread = along;
  }
  if (minorSpread * 2 > LINE_CONTACT_MM) return null;
  const my = vertical.reduce((s, c) => s + c.p[1], 0) / vertical.length;
  const point: Vec3 = [mx, my, mz];
  for (const c of contacts) {
    // Velocity of the contact point for a unit turn about the axis, projected on the contact normal (mm).
    const rx = c.p[0] - point[0];
    const ry = c.p[1] - point[1];
    const rz = c.p[2] - point[2];
    const vx = major[1] * rz - major[2] * ry;
    const vy = major[2] * rx - major[0] * rz;
    const vz = major[0] * ry - major[1] * rx;
    if (Math.abs(c.n[0] * vx + c.n[1] * vy + c.n[2] * vz) > HINGE_BLOCK_MM) return null;
  }
  return { axis: major, point };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Horizontal distance (mm) of the centre of gravity from the vertical plane through the hinge's axis, and how far below the axis it sits. */
function pendulumOf(hinge: Hinge, com: Vec3): { offsetMm: number; belowMm: number } {
  const dx = com[0] - hinge.point[0];
  const dz = com[2] - hinge.point[2];
  const perpX = -hinge.axis[2];
  const perpZ = hinge.axis[0];
  return { offsetMm: Math.abs(dx * perpX + dz * perpZ), belowMm: hinge.point[1] - com[1] };
}

export interface HangInput {
  tool: ToolBody;
  placement: Placement;
  /** Holder, neighbouring holders and tools, shelves: everything the tool can touch. */
  obstacles: readonly SolidBody[];
  /** The holder the tool hangs on (one of `obstacles`): how the tool sits in it (jammed, reaching out below) is judged against it. Without one only the contacts are judged. */
  holder?: SolidBody;
  /** Try leaning the tool back against the wall when it stands but nothing holds it (the seat search, which writes the lean into the pose); a pose as stored is judged as it is. */
  leanBack?: boolean;
  options?: Partial<HangOptions>;
}

/** Lean angles (degrees) tried, smallest first, when a tool is not in equilibrium where it was put. */
const LEAN_STEPS_DEG: readonly number[] = [1.5, 3, 5, 8];

function analyseAt(
  tool: ToolBody,
  placement: Placement,
  obstacles: readonly SolidBody[],
  options: HangOptions,
  holder: SolidBody | undefined,
): { report: HangReport; contacts: Contact[]; penetrationMm: number; fallMm: number } {
  const near = nearbyObstacles(worldBounds(tool, placement), obstacles);
  const { grid, di, dj, y } = toolGridAt(tool, placement);
  const com = centreOfGravity(tool, placement);
  const scan = scanAll(
    grid,
    near.map((o) => o.grid),
    di,
    dj,
    y,
  );
  const contacts = reduceContacts(findContacts(grid, near, di, dj, y, options.contact));
  const fit =
    holder === undefined
      ? null
      : measureSeatFit(
          { grid, di, dj, y },
          holder.grid(),
          holder.bounds(),
          options.protrudeLimitMm !== undefined,
        );
  return {
    report: withFit(
      judge(tool, com, contacts, scan.fallMm, scan.penetrationMm, options),
      fit,
      options,
    ),
    contacts,
    penetrationMm: scan.penetrationMm,
    fallMm: scan.fallMm,
  };
}

/**
 * Not in equilibrium as put, but a tool in a slot leans against the walls until it is: try small leans about the
 * contact patch and keep the first that holds; null when none does.
 */
function leanUntilStable(
  input: HangInput,
  first: { contacts: Contact[] },
  options: HangOptions,
): HangReport | null {
  const { tool, placement } = input;
  const support = first.contacts.filter((c) => c.kind === 'support' || c.kind === 'ceiling');
  const pivot: Vec3 = support.length > 0 ? meanOf(support) : meanOf(first.contacts);
  for (const deg of LEAN_STEPS_DEG) {
    for (const [axis, sign] of LEAN_AXES) {
      const leaned = leanAbout(placement, pivot, axis, sign * deg);
      const settled = restOnObstacles(tool, leaned, input.obstacles);
      if (settled === null) continue;
      const trial = analyseAt(tool, settled, input.obstacles, options, input.holder);
      if (trial.report.status !== 'unstable') {
        return { ...trial.report, rest: { placement: settled, tiltDeg: deg } };
      }
    }
  }
  return null;
}

export function analyseHangPose(input: HangInput): HangReport {
  const options: HangOptions = { ...DEFAULT_HANG_OPTIONS, ...input.options };
  const { tool, placement } = input;
  const first = analyseAt(tool, placement, input.obstacles, options, input.holder);
  const leans =
    first.report.reasons.some((r) => r.code === 'tips') && first.report.status === 'unstable';
  if (input.leanBack === true && first.contacts.length > 0) {
    const braced = leanBack(tool, placement, first, input.obstacles, options, input.holder);
    if (braced !== null) return braced;
  }
  if (!leans || first.contacts.length === 0) return first.report;
  return leanUntilStable(input, first, options) ?? first.report;
}

/** Lean-back angles (degrees toward the wall) tried, smallest first, for a tool that stands but nothing holds it against a pull. */
const LEAN_BACK_STEPS_DEG: readonly number[] = [2, 4, 6, 9, 12];
/** What a lean back against the wall cures: nothing holds the tool against a pull, or it tips off the edge it stands on (a plate on its rim). */
const LEAN_BACK_FIXES: ReadonlySet<HangReasonCode> = new Set<HangReasonCode>([
  'needs_retention',
  'tips',
]);
/** A tool that has leaned back may touch the wall plane but not sink into it (mm). */
const WALL_TOLERANCE_MM = 0.5;
/** How far (mm) a tool may end lower than it started when it leans back. */
const LEAN_SINK_MM = 4;

/** How far (mm) a tool may have to be lifted at a step of a lean: the unsettled turn grazes its support, a divider is far higher. */
const LEAN_PATH_LIFT_MM = 20;

/**
 * The tool settled at `deg` degrees back about `pivot` (sliding `slideMm` forward on the way), or null when the turn has to climb
 * over a divider or a neighbour, or has nothing to land on.
 */
function leanPath(
  tool: ToolBody,
  placement: Placement,
  pivot: Vec3,
  deg: number,
  slideMm: number,
  obstacles: readonly SolidBody[],
): Placement | null {
  let landed: Placement | null = null;
  // Three looks along the way are enough to see a divider; every degree would cost seconds on a real tool mesh.
  for (const step of new Set([Math.ceil(deg / 3), Math.ceil((2 * deg) / 3), deg])) {
    const turned = leanAbout(placement, pivot, [1, 0, 0], -step);
    const at: Placement = {
      rotation: turned.rotation,
      position: [
        turned.position[0],
        turned.position[1],
        turned.position[2] + (slideMm * step) / deg,
      ],
    };
    const settled = restOnObstacles(tool, at, obstacles);
    // A turn part way that has nothing to land on yet (null) is not a collision; one that has to be lifted a long way is.
    if (settled !== null && settled.position[1] - at.position[1] > LEAN_PATH_LIFT_MM) return null;
    if (step === deg) landed = settled;
  }
  return landed;
}

/**
 * A tool that stands in its holder (on a shelf, a cradle) with nothing against a pull, or that would tip forward off the
 * edge it stands on, leans back against the wall: its centre of gravity moves behind the lip it rests on, and a pull outward
 * has to lift it first. Returns the report of the
 * smallest lean that removes the problem without making anything else worse, with that pose as its rest; null
 * when the tool needs no retention or no lean gives it.
 */
function leanBack(
  tool: ToolBody,
  placement: Placement,
  first: { report: HangReport; contacts: Contact[] },
  obstacles: readonly SolidBody[],
  options: HangOptions,
  holder: SolidBody | undefined,
): HangReport | null {
  const needs = first.report.reasons.some((r) => LEAN_BACK_FIXES.has(r.code));
  if (!needs) return null;
  const support = first.contacts.filter((c) => c.kind === 'support');
  if (support.length === 0) return null;
  const pivot = meanOf(support);
  const known = new Set(first.report.reasons.map((r) => r.code));
  const startMinY = worldBounds(tool, placement).min[1];
  for (const deg of LEAN_BACK_STEPS_DEG) {
    const leaned = leanAbout(placement, pivot, [1, 0, 0], -deg);
    // The part of the tool that was against the wall swings into it: the turn slides the whole tool forward until it only touches.
    const slide = Math.max(0, -worldBounds(tool, leaned).min[2]);
    const settled = leanPath(tool, placement, pivot, deg, slide, obstacles);
    if (settled === null) continue;
    const bounds = worldBounds(tool, settled);
    // A lean is a small turn on the spot: a tool that slips down past its support while turning has found another seat.
    if (bounds.min[2] < -WALL_TOLERANCE_MM || bounds.min[1] < startMinY - LEAN_SINK_MM) continue;
    const trial = analyseAt(tool, settled, obstacles, options, holder);
    const codes = trial.report.reasons.map((r) => r.code);
    if (codes.some((c) => LEAN_BACK_FIXES.has(c) || !known.has(c))) continue;
    if (trial.report.score < first.report.score) continue;
    return { ...trial.report, rest: { placement: settled, tiltDeg: deg } };
  }
  return null;
}

const LEAN_AXES: readonly (readonly [Vec3, number])[] = [
  [[1, 0, 0], 1],
  [[1, 0, 0], -1],
  [[0, 0, 1], 1],
  [[0, 0, 1], -1],
];

function meanOf(contacts: readonly Contact[]): Vec3 {
  const n = contacts.length;
  return [
    contacts.reduce((s, c) => s + c.p[0], 0) / n,
    contacts.reduce((s, c) => s + c.p[1], 0) / n,
    contacts.reduce((s, c) => s + c.p[2], 0) / n,
  ];
}

/** `placement` turned by `deg` about the horizontal `axis` through `pivot`. */
function leanAbout(placement: Placement, pivot: Vec3, axis: Vec3, deg: number): Placement {
  const turn = axis[0] !== 0 ? rotationX(deg) : rotationZ(deg);
  const offset = apply(turn, [
    placement.position[0] - pivot[0],
    placement.position[1] - pivot[1],
    placement.position[2] - pivot[2],
  ]);
  return {
    rotation: multiply(turn, placement.rotation),
    position: [pivot[0] + offset[0], pivot[1] + offset[1], pivot[2] + offset[2]],
  };
}

/** Lifts a pose out of interpenetration and lowers it onto the first contact; null when it cannot be freed by lifting. */
function restOnObstacles(
  tool: ToolBody,
  placement: Placement,
  obstacles: readonly SolidBody[],
): Placement | null {
  let position: Vec3 = placement.position;
  for (let attempt = 0; attempt < 8; attempt++) {
    const at: Placement = { rotation: placement.rotation, position };
    const near = nearbyObstacles(worldBounds(tool, at), obstacles);
    const { grid, di, dj, y } = toolGridAt(tool, at);
    const scan = scanAll(
      grid,
      near.map((o) => o.grid),
      di,
      dj,
      y,
    );
    if (scan.penetrationMm > 0.05) {
      position = [position[0], position[1] + scan.penetrationMm + 0.05, position[2]];
      continue;
    }
    if (!Number.isFinite(scan.fallMm)) return null;
    return {
      rotation: placement.rotation,
      position: [position[0], position[1] - scan.fallMm, position[2]],
    };
  }
  return null;
}

const ZERO_MARGINS: Record<DisturbanceName, number> = {
  left: 0,
  right: 0,
  outward: 0,
  inward: 0,
  up: 0,
  down: 0,
};

export function judge(
  tool: ToolBody,
  com: Vec3,
  contacts: readonly Contact[],
  fallMm: number,
  penetrationMm: number,
  options: HangOptions,
): HangReport {
  const reasons: HangReason[] = [];
  const eq = options.equilibrium;
  let score = 1;
  let marginsG = { ...ZERO_MARGINS };

  // The board only holds a tool that is pulled onto it (a magnet); otherwise touching it is not being held.
  const holdsOnWall = (eq.magnetPullG ?? 0) > 0;
  const holdingContacts = contacts.filter((c) => c.kind !== 'wall' || holdsOnWall);
  if (penetrationMm > options.penetrationLimitMm) {
    reasons.push({ code: 'penetrates', params: { depthMm: round1(penetrationMm) } });
    score = Math.min(score, 0.35);
  }
  if (holdingContacts.length === 0) {
    reasons.push({
      code: 'levitating',
      params: Number.isFinite(fallMm) ? { gapMm: round1(fallMm) } : { gapMm: -1 },
    });
    return finish(tool, 0, reasons, marginsG, 0, penetrationMm, null);
  }

  const rest = balances(contacts, com, eq);
  if (!rest.ok) {
    const forceOnly = balances(contacts, com, eq, [0, 0, 0], 0, true);
    reasons.push({
      code: forceOnly.ok ? 'tips' : 'falls',
      params: { residual: round3(rest.residual) },
    });
    score = forceOnly.ok ? Math.min(score, 0.2) : 0.05;
    return finish(tool, score, reasons, marginsG, contacts.length, penetrationMm, null);
  }

  const names = Object.keys(DISTURBANCES) as DisturbanceName[];
  marginsG = { ...ZERO_MARGINS };
  for (const name of names) marginsG[name] = marginAlong(contacts, com, eq, DISTURBANCES[name]);

  const lateral = judgeLateral(contacts, com, marginsG, options, reasons);
  score = Math.min(score, lateral.cap);
  score = Math.min(score, judgeRetention(tool, marginsG, options, reasons));
  return finish(tool, score, reasons, marginsG, contacts.length, penetrationMm, lateral.swingDeg);
}

/** Side-to-side stability: a hinged tool swings (or tips above its hinge), anything else must resist a sideways bump. Cap on the score. */
function judgeLateral(
  contacts: readonly Contact[],
  com: Vec3,
  marginsG: Record<DisturbanceName, number>,
  options: HangOptions,
  reasons: HangReason[],
): { cap: number; swingDeg: number | null } {
  const eq = options.equilibrium;
  const side = Math.min(marginsG.left, marginsG.right);
  const hinge = hingeOf(contacts);
  if (hinge) {
    const pendulum = pendulumOf(hinge, com);
    if (pendulum.belowMm < 0 || pendulum.offsetMm > HINGE_COM_OFFSET_MM) {
      reasons.push({ code: 'tips', params: { aboveMm: round1(-pendulum.belowMm) } });
      return { cap: 0.15, swingDeg: null };
    }
    const tilt = Math.atan(options.bumpG);
    const swingDeg = Math.round((tilt * 180) / Math.PI);
    const swayMm = pendulum.belowMm * Math.sin(tilt);
    if (swayMm >= SWING_REPORT_MM) {
      reasons.push({ code: 'swings', params: { swingDeg, swayMm: Math.round(swayMm) } });
    }
    return { cap: 0.95 - 0.45 * clamp01(swayMm / 150), swingDeg };
  }
  if (side < options.bumpG * REFERENCE_MARGIN_FACTOR) {
    const bump = options.bumpG;
    const left = balances(contacts, com, eq, DISTURBANCES.left, bump, true).ok;
    const right = balances(contacts, com, eq, DISTURBANCES.right, bump, true).ok;
    reasons.push({
      code: left && right ? 'tips' : 'slides_off',
      params: { marginG: round3(side), neededG: bump },
    });
    return { cap: 0.25 + 0.5 * clamp01(side / bump), swingDeg: null };
  }
  return { cap: Infinity, swingDeg: null };
}

/** Hold against a pull and the holder's load limit. Cap on the score. */
function judgeRetention(
  tool: ToolBody,
  marginsG: Record<DisturbanceName, number>,
  options: HangOptions,
  reasons: HangReason[],
): number {
  let cap = Infinity;
  if (marginsG.outward < options.pullG * REFERENCE_MARGIN_FACTOR) {
    reasons.push({
      code: 'needs_retention',
      params: { marginG: round3(marginsG.outward), neededG: options.pullG },
    });
    cap = 0.4 + 0.4 * clamp01(marginsG.outward / options.pullG);
  }
  if (options.maxLoadG !== undefined && tool.massG > options.maxLoadG) {
    reasons.push({
      code: 'overloaded',
      params: { massG: Math.round(tool.massG), maxLoadG: options.maxLoadG },
    });
    cap = Math.min(cap, 0.3);
  }
  return cap;
}

const WEDGED_SCORE = 0.35;
const PROTRUDES_SCORE = 0.7;

function statusOf(score: number): HangStatus {
  return score >= 0.8 ? 'stable' : score >= 0.45 ? 'marginal' : 'unstable';
}

/** Adds what the contacts cannot tell: a tool stuck in an opening it does not fit, and one that reaches out below a holder too shallow for it. */
function withFit(report: HangReport, fit: SeatFit | null, options: HangOptions): HangReport {
  if (fit === null) return report;
  const reasons = [...report.reasons];
  let score = report.score;
  if (fit.wedgedMm >= WEDGED_MIN_MM) {
    reasons.push({ code: 'wedged', params: { depthMm: round1(fit.wedgedMm) } });
    score = Math.min(score, WEDGED_SCORE);
  }
  if (options.protrudeLimitMm !== undefined && fit.protrudeMm > options.protrudeLimitMm) {
    reasons.push({ code: 'protrudes', params: { protrudeMm: round1(fit.protrudeMm) } });
    score = Math.min(score, PROTRUDES_SCORE);
  }
  return reasons.length === report.reasons.length
    ? report
    : { ...report, reasons, score, status: statusOf(score) };
}

function finish(
  tool: ToolBody,
  score: number,
  reasons: HangReason[],
  marginsG: Record<DisturbanceName, number>,
  contactCount: number,
  penetrationMm: number,
  swingDeg: number | null,
): HangReport {
  const rounded = Math.round(clamp01(score) * 100) / 100;
  const status = statusOf(rounded);
  return {
    score: rounded,
    status,
    reasons,
    marginsG,
    massG: tool.massG,
    contactCount,
    penetrationMm: round1(penetrationMm),
    swingDeg,
    rest: null,
  };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;
const round3 = (v: number): number => Math.round(v * 1000) / 1000;
