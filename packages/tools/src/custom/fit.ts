/**
 * Closed-form-first fit of a class generator to an observed silhouette profile (the output of the
 * vision sidecar's `fit_profile`: stations of lateral extents along the principal axis, wide end first).
 *
 * No renderer in the loop: the generator is built at LOD1 and its section widths along Y are compared to
 * the observed widths. Steps: uniform length scaling, orientation test (front/side x flipped), coordinate
 * descent over the numeric dimension parameters, greedy choice of style options.
 */
import { clamp, lerp } from '../math.ts';
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
}

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
