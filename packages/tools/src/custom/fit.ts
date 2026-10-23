/**
 * Closed-form-first fit of a class generator to an observed silhouette profile (the output of the
 * vision sidecar's `fit_profile`: stations of lateral extents along the principal axis, wide end first).
 *
 * No renderer in the loop: the generator is built at LOD1 and its section widths along Y are compared to
 * the observed widths. Steps: uniform length scaling, orientation test (front/side x flipped), coordinate
 * descent over the numeric dimension parameters, greedy choice of style options.
 */
import { clamp, lerp, sizeOf } from '../math.ts';
import { type ToolModel, sectionExtentsAt } from '../model.ts';
import type { AnyValues, NumSpec, ParamValue } from '../params.ts';
import { type AnyToolClass, generate, getToolClass } from '../registry.ts';
import type { ObservedProfile } from './schema.ts';

export interface ClassFit {
  classId: string;
  params: AnyValues;
  view: 'front' | 'side';
  flipped: boolean;
  /** IoU of the generated width profile against the observed one (0..1). */
  iou: number;
  /** Root-mean-square width error in mm. */
  rmsMm: number;
  lengthMm: number;
  evals: number;
}

export interface FitOptions {
  /** Parameters the user fixed; never changed by the search. */
  fixed?: Readonly<Record<string, ParamValue>>;
  /** Start values (defaults of the class when omitted). */
  start?: Readonly<Record<string, ParamValue>>;
  maxEvals?: number;
  /** Exact overall size (mm) of the generated model to reach after the shape fit, as far as the class ranges allow. */
  targets?: DimensionTargets;
}

export interface DimensionTargets {
  lengthMm?: number | undefined;
  /** The length is the profile's own, not typed: it yields to a typed width. */
  lengthHeld?: boolean | undefined;
  widthMm?: number | undefined;
}

/** The refinement stops when every targeted size is within this many mm. */
const TARGET_TOLERANCE_MM = 0.005;
const REFINE_ITERATIONS = 12;
/** Passes on the full-detail model, which the cheap-model result is already close to. */
const POLISH_ITERATIONS = 5;
/** Largest change of one parameter per refinement step (a factor), so a bad Jacobian cannot throw the shape away. */
const MAX_STEP_LOG = Math.log(3);

const SAMPLES = 28;

export function observedWidthAt(profile: ObservedProfile, t: number): number {
  const st = profile.stations;
  const c = clamp(t, st[0]?.t ?? 0, st[st.length - 1]?.t ?? 1);
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i];
    const b = st[i + 1];
    if (!a || !b) continue;
    if (c >= a.t && c <= b.t) {
      const u = b.t === a.t ? 0 : (c - a.t) / (b.t - a.t);
      return Math.max(0, lerp(a.hi - a.lo, b.hi - b.lo, u));
    }
  }
  const last = st[st.length - 1];
  return last ? Math.max(0, last.hi - last.lo) : 0;
}

function widthsAlong(model: ToolModel, view: 'front' | 'side', n: number): number[] {
  const y0 = model.bounds.min[1];
  const y1 = model.bounds.max[1];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const y = clamp(y0 + ((i + 0.5) / n) * (y1 - y0), y0 + 1e-3, y1 - 1e-3);
    const e = sectionExtentsAt(model.parts, y);
    out.push(e.maxX < e.minX ? 0 : view === 'front' ? e.maxX - e.minX : e.maxZ - e.minZ);
  }
  return out;
}

function profileMaxWidth(profile: ObservedProfile): number {
  return Math.max(...profile.stations.map((s) => s.hi - s.lo), 1e-6);
}

interface Score {
  loss: number;
  iou: number;
  rmsMm: number;
  lengthMm: number;
}

function score(
  model: ToolModel,
  obs: ObservedProfile,
  view: 'front' | 'side',
  flipped: boolean,
): Score {
  const length = model.bounds.max[1] - model.bounds.min[1];
  const gen = widthsAlong(model, view, SAMPLES);
  const wmax = profileMaxWidth(obs);
  let sq = 0;
  let inter = 0;
  let union = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const u = (i + 0.5) / SAMPLES;
    const wo = observedWidthAt(obs, flipped ? 1 - u : u);
    const wg = gen[i] ?? 0;
    sq += (wg - wo) ** 2;
    inter += Math.min(wg, wo);
    union += Math.max(wg, wo);
  }
  const lenErr = (length - obs.lengthMm) / obs.lengthMm;
  const rel = sq / SAMPLES / wmax ** 2;
  return {
    loss: rel + 2 * lenErr ** 2,
    iou: union > 0 ? inter / union : 0,
    rmsMm: Math.sqrt(sq / SAMPLES),
    lengthMm: length,
  };
}

function dimensionParams(cls: AnyToolClass, fixed: ReadonlySet<string>): [string, NumSpec][] {
  return Object.entries(cls.schema).flatMap(([key, spec]) =>
    spec.kind === 'num' && spec.dimension && spec.unit === 'mm' && !fixed.has(key)
      ? ([[key, spec]] as [string, NumSpec][])
      : [],
  );
}

export function fitClassToProfile(
  classId: string,
  obs: ObservedProfile,
  options: FitOptions = {},
): ClassFit {
  const cls = getToolClass(classId);
  const fixed = new Set(Object.keys(options.fixed ?? {}));
  const dims = dimensionParams(cls, fixed);
  const maxEvals = options.maxEvals ?? 220;
  let evals = 0;
  const values: AnyValues = { ...options.start, ...options.fixed };
  const build = (v: AnyValues): ToolModel => {
    evals++;
    return generate(classId, v, 1);
  };

  // 1. uniform length scale of all mm dimensions
  let model = build(values);
  for (let pass = 0; pass < 2; pass++) {
    const length = model.bounds.max[1] - model.bounds.min[1];
    const s = obs.lengthMm / Math.max(length, 1e-6);
    if (Math.abs(s - 1) < 0.01) break;
    for (const [key, spec] of dims) {
      const cur = typeof values[key] === 'number' ? (values[key] as number) : spec.def;
      values[key] = clamp(cur * s, spec.min, spec.max);
    }
    model = build(values);
  }

  // 2. orientation: front/side x flipped, keep the best
  let best = {
    view: 'front' as 'front' | 'side',
    flipped: false,
    s: score(model, obs, 'front', false),
  };
  for (const view of ['front', 'side'] as const) {
    for (const flipped of [false, true]) {
      const s = score(model, obs, view, flipped);
      if (s.loss < best.s.loss) best = { view, flipped, s };
    }
  }

  // 3. coordinate descent over dimensions, then style choices, then one more descent pass
  let cur = best.s;
  const tryValue = (key: string, v: ParamValue): boolean => {
    if (evals >= maxEvals) return false;
    const next = { ...values, [key]: v };
    const m = build(next);
    const s = score(m, obs, best.view, best.flipped);
    if (s.loss < cur.loss - 1e-9) {
      values[key] = v;
      cur = s;
      model = m;
      return true;
    }
    return false;
  };
  const descend = (deltas: readonly number[]): void => {
    for (const d of deltas) {
      for (const [key, spec] of dims) {
        const now = typeof values[key] === 'number' ? (values[key] as number) : spec.def;
        const up = clamp(now * (1 + d), spec.min, spec.max);
        const down = clamp(now * (1 - d), spec.min, spec.max);
        if (up !== now && tryValue(key, up)) continue;
        if (down !== now) tryValue(key, down);
      }
    }
  };
  descend([0.3, 0.15, 0.07]);
  for (const [key, spec] of Object.entries(cls.schema)) {
    if (spec.kind !== 'choice' || fixed.has(key)) continue;
    for (const option of spec.options) {
      if (option !== (values[key] ?? spec.def)) tryValue(key, option);
    }
  }
  descend([0.1, 0.04]);
  if (options.targets) {
    // the exact sizes the user typed beat the silhouette loss: refine on the cheap fit-time model, polish on the
    // full-detail one (its extra geometry changes the outer size a little), then re-score the shape that results
    refineToTargets(dims, values, options.targets, build, REFINE_ITERATIONS);
    model = refineToTargets(
      dims,
      values,
      options.targets,
      (v) => {
        evals++;
        return generate(classId, v, 0);
      },
      POLISH_ITERATIONS,
    );
    cur = score(model, obs, best.view, best.flipped);
  }
  const params = Object.fromEntries(
    Object.entries(cls.schema).map(([key, spec]) => [key, values[key] ?? spec.def]),
  ) as AnyValues;
  return {
    classId,
    params,
    view: best.view,
    flipped: best.flipped,
    iou: clamp(cur.iou, 0, 1),
    rmsMm: cur.rmsMm,
    lengthMm: cur.lengthMm,
    evals,
  };
}

interface Goal {
  target: number;
  /** 1 for a typed size; small for a size that is only held. */
  weight: number;
  read: (model: ToolModel) => number;
}

const HELD_WEIGHT = 1e-3;

/** Minimum-norm solution of `J d = -err` for one or two goals; `null` when the goals do not respond to any parameter. */
function minNormStep(
  jacobian: readonly (readonly number[])[],
  err: readonly number[],
): number[] | null {
  const n = jacobian[0]?.length ?? 0;
  const dot = (a: readonly number[], b: readonly number[]): number =>
    a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);
  const row = (i: number): readonly number[] => jacobian[i] ?? [];
  const single = (i: number): number[] | null => {
    const g = dot(row(i), row(i));
    if (g < 1e-12) return null;
    const scale = -(err[i] ?? 0) / g;
    return row(i).map((x) => x * scale);
  };
  if (jacobian.length === 1) return n === 0 ? null : single(0);
  const a = dot(row(0), row(0));
  const b = dot(row(0), row(1));
  const d = dot(row(1), row(1));
  const det = a * d - b * b;
  if (det > 1e-9 * a * d && a * d > 0) {
    // lambda = (J Jt)^-1 (-err); step = Jt lambda
    const l0 = (-(err[0] ?? 0) * d + (err[1] ?? 0) * b) / det;
    const l1 = (-(err[1] ?? 0) * a + (err[0] ?? 0) * b) / det;
    return row(0).map((x, i) => x * l0 + (row(1)[i] ?? 0) * l1);
  }
  // the goals pull the same parameters the same way: no joint step; the caller serves them one at a time
  return null;
}

/**
 * After the silhouette fit: nudge the class's mm dimensions (minimum change in log space, clamped to the class ranges)
 * until the model's overall length / width are exactly the targets. A target the ranges cannot hold ends at the
 * nearest reachable size. Mutates `values`, returns the model built from them.
 */
function refineToTargets(
  dims: readonly [string, NumSpec][],
  values: AnyValues,
  targets: DimensionTargets,
  build: (v: AnyValues) => ToolModel,
  iterations: number,
): ToolModel {
  const goals: Goal[] = [];
  if (targets.lengthMm !== undefined) {
    // a held (not typed) length yields to a typed width when one parameter drives both
    goals.push({
      target: targets.lengthMm,
      weight: targets.lengthHeld ? HELD_WEIGHT : 1,
      read: (m) => sizeOf(m.bounds)[1],
    });
  }
  if (targets.widthMm !== undefined) {
    goals.push({ target: targets.widthMm, weight: 1, read: (m) => sizeOf(m.bounds)[0] });
  }
  const valueOf = (key: string, spec: NumSpec): number =>
    typeof values[key] === 'number' ? (values[key] as number) : spec.def;
  const errorsOf = (m: ToolModel): number[] => goals.map((g) => g.read(m) - g.target);
  const worst = (errors: readonly number[]): number => Math.max(...errors.map(Math.abs));
  /** Squared relative error: a target the ranges cannot reach does not hide progress on the other one. */
  const lossOf = (errors: readonly number[]): number =>
    errors.reduce(
      (sum, e, i) => sum + (goals[i]?.weight ?? 1) * (e / (goals[i]?.target ?? 1)) ** 2,
      0,
    );
  /** Which single goal to serve first: the typed ones, then by how far off (relative) they are. */
  const priority = (i: number, errors: readonly number[]): number =>
    (goals[i]?.weight ?? 1) * Math.abs((errors[i] ?? 0) / (goals[i]?.target ?? 1));
  let model = build(values);
  const pinned = new Set<string>();
  // a parameter that hit its bound stays pinned for the rest of this pass: the bound is the answer for its goal
  for (let iteration = 0; iteration < iterations && goals.length > 0; iteration++) {
    const err = errorsOf(model);
    if (worst(err) <= TARGET_TOLERANCE_MM) break;
    const active = dims.filter(([key]) => !pinned.has(key));
    if (active.length === 0) break;
    const jacobian: number[][] = goals.map(() => []);
    for (const [key, spec] of active) {
      const now = valueOf(key, spec);
      // probe away from the bound the value sits on
      let probe = clamp(now * 1.01, spec.min, spec.max);
      if (probe === now) probe = clamp(now * 0.99, spec.min, spec.max);
      const sensitivity = probe === now ? null : build({ ...values, [key]: probe });
      goals.forEach((g, i) => {
        const change =
          sensitivity === null ? 0 : (g.read(sensitivity) - g.read(model)) / Math.log(probe / now);
        jacobian[i]?.push(change);
      });
    }
    // all goals together first; when that cannot improve (one of them is out of reach), each goal alone, worst first
    const all = goals.map((_, i) => i);
    const subsets = [
      all,
      ...(all.length > 1 ? [...all].sort((a, b) => priority(b, err) - priority(a, err)).map((i) => [i]) : []),
    ];
    let moved = false;
    for (const subset of subsets) {
      if (moved) break;
      const step = minNormStep(
        subset.map((i) => jacobian[i] ?? []),
        subset.map((i) => err[i] ?? 0),
      );
      if (step === null) continue;
      const biggest = Math.max(...step.map(Math.abs));
      const damp = biggest > MAX_STEP_LOG ? MAX_STEP_LOG / biggest : 1;
      for (let shrink = 1; shrink >= 0.25 && !moved; shrink /= 2) {
        const next: AnyValues = { ...values };
        const clamped: string[] = [];
        active.forEach(([key, spec], j) => {
          const wanted = valueOf(key, spec) * Math.exp(damp * shrink * (step[j] ?? 0));
          next[key] = clamp(wanted, spec.min, spec.max);
          if (next[key] !== wanted) clamped.push(key);
        });
        const built = build(next);
        if (lossOf(errorsOf(built)) < lossOf(err)) {
          Object.assign(values, next);
          model = built;
          for (const key of clamped) pinned.add(key);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return model;
}

/** Uniformly rescale an observed profile to a new length (user-entered real dimension). */
export function rescaleProfile(profile: ObservedProfile, lengthMm: number): ObservedProfile {
  const s = lengthMm / profile.lengthMm;
  return {
    lengthMm,
    stations: profile.stations.map((st) => ({ t: st.t, lo: st.lo * s, hi: st.hi * s })),
  };
}

/** Scale the lateral extents so the widest station equals `widthMm` (length unchanged). */
export function setProfileWidth(profile: ObservedProfile, widthMm: number): ObservedProfile {
  const s = widthMm / profileMaxWidth(profile);
  return {
    lengthMm: profile.lengthMm,
    stations: profile.stations.map((st) => ({ t: st.t, lo: st.lo * s, hi: st.hi * s })),
  };
}

export { profileMaxWidth };
