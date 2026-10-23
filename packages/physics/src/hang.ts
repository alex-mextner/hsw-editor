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
import { scanAll } from './settle.ts';

export type HangReasonCode =
  | 'levitating'
  | 'penetrates'
  | 'falls'
  | 'tips'
  | 'swings'
  | 'slides_off'
  | 'needs_retention'
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
  options?: Partial<HangOptions>;
}

/** Lean angles (degrees) tried, smallest first, when a tool is not in equilibrium where it was put. */
const LEAN_STEPS_DEG: readonly number[] = [1.5, 3, 5, 8];

function analyseAt(
  tool: ToolBody,
  placement: Placement,
  obstacles: readonly SolidBody[],
  options: HangOptions,
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
  return {
    report: judge(tool, com, contacts, scan.fallMm, scan.penetrationMm, options),
    contacts,
    penetrationMm: scan.penetrationMm,
    fallMm: scan.fallMm,
  };
}

export function analyseHangPose(input: HangInput): HangReport {
  const options: HangOptions = { ...DEFAULT_HANG_OPTIONS, ...input.options };
  const { tool, placement } = input;
  const first = analyseAt(tool, placement, input.obstacles, options);
  const leans =
    first.report.reasons.some((r) => r.code === 'tips') && first.report.status === 'unstable';
  if (!leans || first.contacts.length === 0) return first.report;
  // Not in equilibrium as put, but a tool in a slot leans against the walls until it is: try small leans about the
  // contact patch and keep the first that holds.
  const support = first.contacts.filter((c) => c.kind === 'support' || c.kind === 'ceiling');
  const pivot: Vec3 = support.length > 0 ? meanOf(support) : meanOf(first.contacts);
  for (const deg of LEAN_STEPS_DEG) {
    for (const [axis, sign] of LEAN_AXES) {
      const leaned = leanAbout(placement, pivot, axis, sign * deg);
      const settled = restOnObstacles(tool, leaned, input.obstacles);
      if (settled === null) continue;
      const trial = analyseAt(tool, settled, input.obstacles, options);
      if (trial.report.status !== 'unstable') {
        return { ...trial.report, rest: { placement: settled, tiltDeg: deg } };
      }
    }
  }
  return first.report;
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
  let swingDeg: number | null = null;
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

  const side = Math.min(marginsG.left, marginsG.right);
  const hinge = hingeOf(contacts);
  if (hinge) {
    const pendulum = pendulumOf(hinge, com);
    if (pendulum.belowMm < 0 || pendulum.offsetMm > HINGE_COM_OFFSET_MM) {
      reasons.push({ code: 'tips', params: { aboveMm: round1(-pendulum.belowMm) } });
      score = Math.min(score, 0.15);
    } else {
      const tilt = Math.atan(options.bumpG);
      swingDeg = Math.round((tilt * 180) / Math.PI);
      const swayMm = pendulum.belowMm * Math.sin(tilt);
      if (swayMm >= SWING_REPORT_MM) {
        reasons.push({ code: 'swings', params: { swingDeg, swayMm: Math.round(swayMm) } });
      }
      score = Math.min(score, 0.95 - 0.45 * clamp01(swayMm / 150));
    }
  } else if (side < options.bumpG) {
    const bump = options.bumpG;
    const left = balances(contacts, com, eq, DISTURBANCES.left, bump, true).ok;
    const right = balances(contacts, com, eq, DISTURBANCES.right, bump, true).ok;
    reasons.push({
      code: left && right ? 'tips' : 'slides_off',
      params: { marginG: round3(side), neededG: bump },
    });
    score = Math.min(score, 0.25 + 0.5 * clamp01(side / bump));
  }
  if (marginsG.outward < options.pullG) {
    reasons.push({
      code: 'needs_retention',
      params: { marginG: round3(marginsG.outward), neededG: options.pullG },
    });
    score = Math.min(score, 0.4 + 0.4 * clamp01(marginsG.outward / options.pullG));
  }
  if (options.maxLoadG !== undefined && tool.massG > options.maxLoadG) {
    reasons.push({
      code: 'overloaded',
      params: { massG: Math.round(tool.massG), maxLoadG: options.maxLoadG },
    });
    score = Math.min(score, 0.3);
  }
  return finish(tool, score, reasons, marginsG, contacts.length, penetrationMm, swingDeg);
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
  const status: HangStatus = rounded >= 0.8 ? 'stable' : rounded >= 0.45 ? 'marginal' : 'unstable';
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
