/**
 * Size snapping: whatever the user types (or drags a handle to), the result is a size that can actually be
 * built. Three kinds of feasible sets exist in HSW:
 *   - `grid-span`: a span that covers whole honeycomb cells (plates, rails),
 *   - `ladder`: the discrete rungs of a bank family (variants of one design),
 *   - `range`: a continuous generator parameter with min/max/step (bank `ParamDef`),
 * each optionally capped by what the printer can produce. `snapSize` returns `{requested, snapped, reason}`
 * so the UI can show what changed and why; the reason is a code plus numbers, localised by the UI.
 */
import { MM_EPSILON } from './units.ts';

export type SizeConstraint =
  | { kind: 'range'; min: number; max: number; step: number }
  | { kind: 'ladder'; values: readonly number[] }
  | { kind: 'grid-span'; pitchMm: number; minCells: number; maxCells: number };

export type Rounding = 'nearest' | 'up' | 'down';

export type SnapReason =
  | { code: 'exact' }
  | { code: 'rounded-to-step'; stepMm: number }
  | { code: 'nearest-rung' }
  | { code: 'whole-cells'; cells: number; pitchMm: number }
  | { code: 'min-limit'; limitMm: number }
  | { code: 'max-limit'; limitMm: number }
  | { code: 'printable-limit'; limitMm: number }
  /** Even the smallest feasible value exceeds the printable limit: nothing can be built. */
  | { code: 'unbuildable'; limitMm: number };

export interface SizeSnap {
  requested: number;
  snapped: number;
  changed: boolean;
  /** False only for `unbuildable`. */
  feasible: boolean;
  reason: SnapReason;
}

export interface SizeOptions {
  /** Largest dimension the printer can make along this axis. */
  printMaxMm?: number;
  rounding?: Rounding;
}

/** Removes floating-point dust (min + k * step) at 1e-9 mm. */
function roundTo(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

function pick(value: number, rounding: Rounding): number {
  if (rounding === 'up') return Math.ceil(value - 1e-9);
  if (rounding === 'down') return Math.floor(value + 1e-9);
  return Math.round(value);
}

interface Candidate {
  value: number;
  reason: SnapReason;
}

function sortedRungs(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function smallest(c: SizeConstraint): number {
  if (c.kind === 'range') return c.min;
  if (c.kind === 'grid-span') return c.minCells * c.pitchMm;
  return sortedRungs(c.values)[0]!;
}

function snapToConstraint(value: number, c: SizeConstraint, rounding: Rounding): Candidate {
  if (c.kind === 'range') {
    const kMax = Math.floor((c.max - c.min) / c.step + 1e-9);
    const top = roundTo(c.min + kMax * c.step);
    if (value < c.min - MM_EPSILON)
      return { value: c.min, reason: { code: 'min-limit', limitMm: c.min } };
    if (value > c.max + MM_EPSILON)
      return { value: top, reason: { code: 'max-limit', limitMm: top } };
    const k = Math.min(kMax, Math.max(0, pick((value - c.min) / c.step, rounding)));
    return {
      value: roundTo(c.min + k * c.step),
      reason: { code: 'rounded-to-step', stepMm: c.step },
    };
  }
  if (c.kind === 'ladder') {
    const rungs = sortedRungs(c.values);
    const first = rungs[0]!;
    const last = rungs[rungs.length - 1]!;
    if (value < first) return { value: first, reason: { code: 'min-limit', limitMm: first } };
    if (value > last) return { value: last, reason: { code: 'max-limit', limitMm: last } };
    let best = first;
    for (const rung of rungs) {
      if (rounding === 'up') {
        if (rung >= value - MM_EPSILON) {
          best = rung;
          break;
        }
      } else if (rounding === 'down') {
        if (rung <= value + MM_EPSILON) best = rung;
      } else if (Math.abs(rung - value) <= Math.abs(best - value) + MM_EPSILON) {
        // `<=` while scanning upwards: a tie goes to the larger rung (a too-small slot is useless).
        best = rung;
      }
    }
    return { value: best, reason: { code: 'nearest-rung' } };
  }
  const minCells = c.minCells;
  const raw = value / c.pitchMm;
  if (raw < minCells - 1e-9 && pick(raw, rounding) < minCells) {
    const limit = minCells * c.pitchMm;
    return { value: limit, reason: { code: 'min-limit', limitMm: limit } };
  }
  if (raw > c.maxCells + 1e-9 && pick(raw, rounding) > c.maxCells) {
    const limit = c.maxCells * c.pitchMm;
    return { value: limit, reason: { code: 'max-limit', limitMm: limit } };
  }
  const cells = Math.min(c.maxCells, Math.max(minCells, pick(raw, rounding)));
  return { value: cells * c.pitchMm, reason: { code: 'whole-cells', cells, pitchMm: c.pitchMm } };
}

/** Largest feasible value that is <= `limit`, or null when even the smallest one is larger. */
function largestAtMost(limit: number, c: SizeConstraint): number | null {
  if (c.kind === 'range') {
    if (limit < c.min - 1e-9) return null;
    const k = Math.floor((Math.min(limit, c.max) - c.min) / c.step + 1e-9);
    return roundTo(c.min + k * c.step);
  }
  if (c.kind === 'ladder') {
    let best: number | null = null;
    for (const rung of sortedRungs(c.values)) if (rung <= limit + MM_EPSILON) best = rung;
    return best;
  }
  const cells = Math.min(c.maxCells, Math.floor(limit / c.pitchMm + 1e-9));
  return cells >= c.minCells ? cells * c.pitchMm : null;
}

/** A malformed constraint is a bug in the caller's data (bank params, family rungs), not a user error: throw. */
function assertConstraint(c: SizeConstraint): void {
  const finite = Number.isFinite;
  if (c.kind === 'range') {
    if (!(finite(c.min) && finite(c.max) && c.min <= c.max && finite(c.step) && c.step > 0)) {
      throw new RangeError('size range needs finite min <= max and a positive step');
    }
  } else if (c.kind === 'ladder') {
    if (c.values.length === 0 || !c.values.every(finite)) {
      throw new RangeError('size ladder needs at least one finite rung');
    }
  } else if (
    !(
      finite(c.pitchMm) &&
      c.pitchMm > 0 &&
      Number.isInteger(c.minCells) &&
      Number.isInteger(c.maxCells)
    ) ||
    c.minCells < 1 ||
    c.minCells > c.maxCells
  ) {
    throw new RangeError('grid span needs a positive pitch and 1 <= minCells <= maxCells');
  }
}

export function snapSize(
  requested: number,
  constraint: SizeConstraint,
  options: SizeOptions = {},
): SizeSnap {
  if (!Number.isFinite(requested)) throw new RangeError('requested size must be a finite number');
  assertConstraint(constraint);
  const rounding = options.rounding ?? 'nearest';
  let { value, reason } = snapToConstraint(requested, constraint, rounding);
  const printMax = options.printMaxMm;
  let feasible = true;
  if (printMax !== undefined && value > printMax + MM_EPSILON) {
    const capped = largestAtMost(printMax, constraint);
    if (capped === null) {
      feasible = false;
      value = smallest(constraint);
      reason = { code: 'unbuildable', limitMm: printMax };
    } else {
      value = capped;
      reason = { code: 'printable-limit', limitMm: printMax };
    }
  }
  const changed = Math.abs(value - requested) > MM_EPSILON;
  return {
    requested,
    snapped: value,
    changed,
    feasible,
    reason: changed || !feasible ? reason : { code: 'exact' },
  };
}

/** Snaps several named dimensions at once (the dimension widget): one result per key. */
export function snapSizes(
  requested: Readonly<Record<string, number>>,
  constraints: Readonly<Record<string, { constraint: SizeConstraint; options?: SizeOptions }>>,
): Record<string, SizeSnap> {
  const out: Record<string, SizeSnap> = {};
  for (const [key, value] of Object.entries(requested)) {
    // hasOwn: a dimension called "constructor" or "toString" must not resolve to Object.prototype members.
    const entry = Object.hasOwn(constraints, key) ? constraints[key] : undefined;
    if (entry !== undefined) out[key] = snapSize(value, entry.constraint, entry.options);
  }
  return out;
}

/** Bank `ParamDef` (min/max/step) as a size constraint. */
export function rangeFromParam(param: { min: number; max: number; step: number }): SizeConstraint {
  return { kind: 'range', min: param.min, max: param.max, step: param.step };
}

// ---- variant ladders -------------------------------------------------------------------------------

export interface VariantOption {
  id: string;
  /** Named dimensions of this rung in mm, e.g. `{ length: 160, diameter: 8 }`. */
  dimsMm: Readonly<Record<string, number>>;
}

export interface VariantSnap {
  requested: Readonly<Record<string, number>>;
  /** Null when no variant can be offered (see `reason`). */
  variant: VariantOption | null;
  snapped: Record<string, number>;
  perDimension: { key: string; requested: number; snapped: number; changed: boolean }[];
  reason: VariantReason;
}

export type VariantReason =
  | { code: 'exact' }
  | { code: 'nearest-variant' }
  | { code: 'smallest-fitting-variant' }
  | { code: 'printable-limit'; excluded: number }
  /** No variant defines every requested dimension. */
  | { code: 'no-comparable-variant' }
  /** Every comparable variant exceeds the printable limit. */
  | { code: 'unbuildable' };

export interface VariantOptions {
  /** `fit` = the smallest variant that is at least as large in every requested dimension, else nearest. */
  prefer?: 'nearest' | 'fit';
  /** Largest printable value per dimension; a limit on a dimension a variant does not define does not apply to it. */
  printMaxMm?: Readonly<Record<string, number>>;
  /** Relative importance of a dimension in the nearest-variant distance (default 1). */
  weights?: Readonly<Record<string, number>>;
}

/**
 * Nearest feasible bank variant for requested dimensions. Only variants that define every requested dimension are
 * comparable. Distances are measured per dimension in units of that dimension's spread over the comparable
 * variants (so a 160 mm length and an 8 mm diameter weigh alike); the spread ignores print limits, so excluding a
 * variant never changes which of the remaining ones wins.
 */
export function nearestVariant(
  requested: Readonly<Record<string, number>>,
  variants: readonly VariantOption[],
  options: VariantOptions = {},
): VariantSnap {
  const keys = Object.keys(requested);
  if (!keys.every((key) => Number.isFinite(requested[key]))) {
    throw new RangeError('requested dimensions must be finite numbers');
  }
  const none = (reason: VariantReason): VariantSnap => ({
    requested,
    variant: null,
    snapped: {},
    perDimension: [],
    reason,
  });
  const comparable = variants.filter((v) => keys.every((key) => Object.hasOwn(v.dimsMm, key)));
  if (comparable.length === 0) return none({ code: 'no-comparable-variant' });
  const limits = Object.entries(options.printMaxMm ?? {});
  const eligible = comparable.filter((v) =>
    limits.every(
      ([key, max]) => !Object.hasOwn(v.dimsMm, key) || v.dimsMm[key]! <= max + MM_EPSILON,
    ),
  );
  const excluded = comparable.length - eligible.length;
  if (eligible.length === 0) return none({ code: 'unbuildable' });

  const spread = new Map<string, number>();
  for (const key of keys) {
    const values = comparable.map((v) => v.dimsMm[key]!);
    spread.set(key, Math.max(...values) - Math.min(...values) || 1);
  }
  const weights = options.weights;
  const weightOf = (key: string): number =>
    weights !== undefined && Object.hasOwn(weights, key) ? weights[key]! : 1;
  const distance = (v: VariantOption): number =>
    keys.reduce(
      (sum, key) =>
        sum + weightOf(key) * ((v.dimsMm[key]! - requested[key]!) / spread.get(key)!) ** 2,
      0,
    );
  const covers = (v: VariantOption): boolean =>
    keys.every((key) => v.dimsMm[key]! >= requested[key]! - MM_EPSILON);
  const choose = (candidates: readonly VariantOption[]): VariantOption => {
    const covering = candidates.filter(covers);
    const pool = options.prefer === 'fit' && covering.length > 0 ? covering : candidates;
    let best = pool[0]!;
    let bestDistance = distance(best);
    for (const v of pool) {
      const d = distance(v);
      // Ties go to the variant that is larger in the per-dimension normalised units (a too-small rung is useless).
      const larger = keys.reduce(
        (a, key) => a + (v.dimsMm[key]! - best.dimsMm[key]!) / spread.get(key)!,
        0,
      );
      if (d < bestDistance - 1e-12 || (Math.abs(d - bestDistance) <= 1e-12 && larger > 0)) {
        best = v;
        bestDistance = d;
      }
    }
    return best;
  };

  const best = choose(eligible);
  const snapped: Record<string, number> = {};
  const perDimension = keys.map((key) => {
    const value = best.dimsMm[key]!;
    snapped[key] = value;
    return {
      key,
      requested: requested[key]!,
      snapped: value,
      changed: Math.abs(value - requested[key]!) > MM_EPSILON,
    };
  });
  const reason: VariantReason = perDimension.every((d) => !d.changed)
    ? { code: 'exact' }
    : excluded > 0 && choose(comparable).id !== best.id
      ? { code: 'printable-limit', excluded }
      : options.prefer === 'fit' && covers(best)
        ? { code: 'smallest-fitting-variant' }
        : { code: 'nearest-variant' };
  return { requested, variant: best, snapped, perDimension, reason };
}

/** Short English description of a snap, for logs, the CLI and agents (the UI localises from `reason`). */
export function explainSnap(snap: SizeSnap, unit = 'mm'): string {
  const fmt = (v: number): string => `${Number(v.toFixed(2))} ${unit}`;
  const head = `${fmt(snap.requested)} -> ${fmt(snap.snapped)}`;
  const r = snap.reason;
  switch (r.code) {
    case 'exact':
      return `${fmt(snap.snapped)} is buildable as typed`;
    case 'rounded-to-step':
      return `${head}: sizes come in steps of ${fmt(r.stepMm)}`;
    case 'nearest-rung':
      return `${head}: nearest size of this holder family`;
    case 'whole-cells':
      return `${head}: ${r.cells} whole honeycomb cell${r.cells === 1 ? '' : 's'} (${fmt(r.pitchMm)} each)`;
    case 'min-limit':
      return `${head}: smallest possible size`;
    case 'max-limit':
      return `${head}: largest possible size`;
    case 'printable-limit':
      return `${head}: printer limit ${fmt(r.limitMm)}`;
    case 'unbuildable':
      return `${fmt(snap.requested)} cannot be built: even the smallest size exceeds the printer limit ${fmt(r.limitMm)}`;
  }
}
