/**
 * Static equilibrium of a rigid tool resting on frictional unilateral contacts under gravity plus a disturbance
 * (a bump, a pull). A wrench is balanced iff it lies in the cone spanned by the contact friction-cone generators:
 * a non-negative least squares feasibility test. Forces are in weights of the tool (1 = m g), torques about the
 * centre of gravity are divided by a reference length so that both kinds of row weigh alike.
 */
import type { Vec3 } from '@hsw-editor/compat';
import type { Contact } from './contacts.ts';
import { nnls } from './nnls.ts';

export interface EquilibriumOptions {
  /** Coulomb friction between tool and holder (PETG against plastic/steel is 0.3-0.5, rubber grips 0.7+). */
  frictionMu: number;
  /** Reference length that turns torques into force-like rows. */
  torqueScaleMm: number;
  /** Largest residual (in weights) still counted as balanced; 0.03 of the weight is ~1.5 mm of lever arm at 50 mm. */
  tolerance: number;
  /** Contacts farther apart than this (mm) carry no friction (the tool rattles between them instead of gripping). */
  looseGapMm: number;
  /**
   * A magnet (or any adhesive) holding the tool to the board: an inward pull in weights of the tool, applied at the
   * centre of its wall contacts. It loads the wall contacts, so friction can carry the tool; without wall contact it
   * does nothing. 0 / absent: no pull.
   */
  magnetPullG?: number;
  /** Wall lean: degrees the top of the board leans back (weight presses the tool towards the wall). */
  wallTiltDeg: number;
}

export const DEFAULT_EQUILIBRIUM: EquilibriumOptions = {
  frictionMu: 0.35,
  torqueScaleMm: 50,
  tolerance: 0.03,
  looseGapMm: 0.6,
  wallTiltDeg: 0,
};

/** Disturbance directions in the wall frame (x right, y up, z out of the wall). */
export const DISTURBANCES = {
  left: [-1, 0, 0],
  right: [1, 0, 0],
  outward: [0, 0, 1],
  inward: [0, 0, -1],
  up: [0, 1, 0],
  down: [0, -1, 0],
} as const satisfies Record<string, Vec3>;
export type DisturbanceName = keyof typeof DISTURBANCES;

const FRICTION_EDGES = 8;

/**
 * Keeps the contacts that can matter: per direction class the extreme points of the contact patch (a convex
 * combination of the vertices covers the whole patch), so a few hundred cells become a few dozen contacts.
 */
export function reduceContacts(contacts: readonly Contact[]): Contact[] {
  const classes = new Map<string, Contact[]>();
  for (const c of contacts) {
    const key = `${c.n[0]},${c.n[1]},${c.n[2]}`;
    const list = classes.get(key);
    if (list) list.push(c);
    else classes.set(key, [c]);
  }
  const out: Contact[] = [];
  for (const list of classes.values()) {
    const first = list[0] as Contact;
    // Plane of the patch: the two axes other than the normal axis.
    const axes: readonly [number, number] =
      first.n[1] !== 0 ? [0, 2] : first.n[0] !== 0 ? [1, 2] : [0, 1];
    const keep = new Set<Contact>();
    const directions = 16;
    for (let d = 0; d < directions; d++) {
      const a = (d / directions) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      let best: Contact | undefined;
      let bestV = -Infinity;
      for (const c of list) {
        const v = (c.p[axes[0]] ?? 0) * ca + (c.p[axes[1]] ?? 0) * sa;
        if (v > bestV) {
          bestV = v;
          best = c;
        }
      }
      if (best) keep.add(best);
    }
    const normalAxis = first.n[1] !== 0 ? 1 : first.n[0] !== 0 ? 0 : 2;
    let lo: Contact | undefined;
    let hi: Contact | undefined;
    for (const c of list) {
      if (!lo || (c.p[normalAxis] ?? 0) < (lo.p[normalAxis] ?? 0)) lo = c;
      if (!hi || (c.p[normalAxis] ?? 0) > (hi.p[normalAxis] ?? 0)) hi = c;
    }
    if (lo) keep.add(lo);
    if (hi) keep.add(hi);
    out.push(...keep);
  }
  return out;
}

function tangentsOf(n: Vec3): readonly [Vec3, Vec3] {
  if (n[1] !== 0)
    return [
      [1, 0, 0],
      [0, 0, 1],
    ];
  if (n[0] !== 0)
    return [
      [0, 1, 0],
      [0, 0, 1],
    ];
  return [
    [1, 0, 0],
    [0, 1, 0],
  ];
}

/** Wrench generators (force then scaled torque about `com`) of every friction-cone edge of every contact. */
export function generators(
  contacts: readonly Contact[],
  com: Vec3,
  options: EquilibriumOptions,
  forceOnly: boolean,
): number[][] {
  const cols: number[][] = [];
  const scale = 1 / options.torqueScaleMm;
  for (const c of contacts) {
    const [t1, t2] = tangentsOf(c.n);
    const rx = c.p[0] - com[0];
    const ry = c.p[1] - com[1];
    const rz = c.p[2] - com[2];
    // A loose contact has no preload: it can push but not grip.
    const mu = c.gapMm <= options.looseGapMm ? options.frictionMu : 0;
    const edges = mu === 0 ? 1 : FRICTION_EDGES;
    for (let e = 0; e < edges; e++) {
      const a = (e / FRICTION_EDGES) * Math.PI * 2;
      const ca = mu * Math.cos(a);
      const sa = mu * Math.sin(a);
      const fx = c.n[0] + ca * t1[0] + sa * t2[0];
      const fy = c.n[1] + ca * t1[1] + sa * t2[1];
      const fz = c.n[2] + ca * t1[2] + sa * t2[2];
      const col = [fx, fy, fz];
      if (!forceOnly) {
        col.push(
          (ry * fz - rz * fy) * scale,
          (rz * fx - rx * fz) * scale,
          (rx * fy - ry * fx) * scale,
        );
      }
      cols.push(col);
    }
  }
  return cols;
}

export interface Balance {
  ok: boolean;
  /** Norm of the unbalanced wrench, in weights. */
  residual: number;
}

/** Can the contacts balance gravity plus `scale` weights of disturbance along `direction`? */
export function balances(
  contacts: readonly Contact[],
  com: Vec3,
  options: EquilibriumOptions,
  direction: Vec3 = [0, 0, 0],
  scale = 0,
  forceOnly = false,
): Balance {
  const tilt = (options.wallTiltDeg * Math.PI) / 180;
  const gx = direction[0] * scale;
  const gy = -Math.cos(tilt) + direction[1] * scale;
  const gz = -Math.sin(tilt) + direction[2] * scale;
  // Contacts must supply the opposite of the external force; torque about the CoM of gravity and a bump is zero.
  let b = forceOnly ? [-gx, -gy, -gz] : [-gx, -gy, -gz, 0, 0, 0];
  const pull = options.magnetPullG ?? 0;
  const wallContacts = contacts.filter((c) => c.kind === 'wall');
  if (pull > 0 && wallContacts.length > 0) {
    // External force (0, 0, -pull) at the wall patch: the contacts must also supply (0, 0, +pull) and its torque.
    const n = wallContacts.length;
    const at: Vec3 = [
      wallContacts.reduce((s, c) => s + c.p[0], 0) / n,
      wallContacts.reduce((s, c) => s + c.p[1], 0) / n,
      0,
    ];
    const rx = at[0] - com[0];
    const ry = at[1] - com[1];
    // r x F with F = (0, 0, -pull); the contacts supply the opposite torque.
    const tx = ry * -pull;
    const ty = -(rx * -pull);
    b = forceOnly
      ? [b[0] ?? 0, b[1] ?? 0, (b[2] ?? 0) + pull]
      : [
          b[0] ?? 0,
          b[1] ?? 0,
          (b[2] ?? 0) + pull,
          (b[3] ?? 0) - tx / options.torqueScaleMm,
          (b[4] ?? 0) - ty / options.torqueScaleMm,
          b[5] ?? 0,
        ];
  }
  if (contacts.length === 0) return { ok: false, residual: Math.hypot(gx, gy, gz) };
  const { residual } = nnls(generators(contacts, com, options, forceOnly), b);
  return { ok: residual <= options.tolerance, residual };
}

const MAX_MARGIN_G = 1.5;

/** Largest disturbance (in g) along `direction` the contacts still balance, by bisection; 0 when not even gravity balances. */
export function marginAlong(
  contacts: readonly Contact[],
  com: Vec3,
  options: EquilibriumOptions,
  direction: Vec3,
): number {
  if (!balances(contacts, com, options).ok) return 0;
  if (balances(contacts, com, options, direction, MAX_MARGIN_G).ok) return MAX_MARGIN_G;
  let lo = 0;
  let hi = MAX_MARGIN_G;
  for (let i = 0; i < 9; i++) {
    const mid = (lo + hi) / 2;
    if (balances(contacts, com, options, direction, mid).ok) lo = mid;
    else hi = mid;
  }
  return Math.round(lo * 1000) / 1000;
}
