/**
 * From one observed object (profile, colours, class suggestions) to a custom tool: choose the class
 * (user override or best fit among the suggested ones, generic loft when nothing fits), fit the
 * generator, map photo colours onto parts and build both LODs. Pure: no disk, no sidecar.
 */
import { clamp } from '../math.ts';
import { type ToolModel, sectionExtentsAt } from '../model.ts';
import { sizeOf } from '../math.ts';
import { type AnyValues } from '../params.ts';
import { generate, hasToolClass } from '../registry.ts';
import { scaleMeshZ } from './transform.ts';
import { colorsFromSegments, recolorModel } from './colors.ts';
import {
  type ClassFit,
  fitClassToProfile,
  profileMaxWidth,
  rescaleProfile,
  setProfileWidth,
} from './fit.ts';
import { ToolInputError } from './errors.ts';
import { buildGenericLoft } from './generic.ts';
import type { ColorSegment, CustomTool, ObservedProfile } from './schema.ts';

export interface ClassCandidate {
  classId: string;
  score: number;
}

export interface ObjectObservation {
  /** Wide end first, mm. Required: a photo without scale cannot be fitted (the pipeline asks for one). */
  profile: ObservedProfile;
  colors: readonly ColorSegment[];
  candidates: readonly ClassCandidate[];
  /** Real dimensions known from the photo scale or typed by the user. */
  dimensionsMm?: {
    length?: number | undefined;
    width?: number | undefined;
    thickness?: number | undefined;
  };
  dimensionSource: 'photo' | 'user';
  /** Sidecar kind hint: round objects get round generic sections. */
  profileKind?: string;
}

export interface DraftDecision {
  /** Explicit class (user override); null forces the generic loft; undefined lets the fit decide. */
  classId?: string | null;
  /** User-fixed parameters. */
  fixed?: Readonly<Record<string, number | string>>;
  /** Start values of the search (the previous fit when refitting). */
  start?: Readonly<Record<string, number | string>>;
  /** Explicit part colours (user edits); win over photo colours. */
  partColors?: Readonly<Record<string, string>>;
}

export interface FittedObject {
  classId: string | null;
  params: AnyValues;
  fit: CustomTool['fit'];
  partColors: Record<string, string>;
  dimensionsMm: CustomTool['dimensionsMm'];
  profile: ObservedProfile;
  model: ToolModel;
  modelLod1: ToolModel;
  alternatives: { classId: string; iou: number; score: number }[];
}

const MIN_FIT_IOU = 0.5;
/** A suggestion below this recognition score is only tried when nothing better exists. */
const MIN_CANDIDATE_SCORE = 0.05;

export function contiguousSegments(segments: readonly ColorSegment[]): ColorSegment[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.t0 - b.t0);
  const out: ColorSegment[] = [];
  let at = 0;
  sorted.forEach((seg, i) => {
    const t1 = i === sorted.length - 1 ? 1 : clamp(Math.max(seg.t1, at + 1e-3), 0, 1);
    if (t1 - at > 1e-3) out.push({ ...seg, t0: at, t1 });
    at = Math.max(at, t1);
  });
  return out;
}

function genericThickness(obs: ObjectObservation, widthMm: number): number {
  if (obs.dimensionsMm?.thickness) return obs.dimensionsMm.thickness;
  switch (obs.profileKind) {
    case 'cylinder_capsule':
    case 'lathe_profile':
    case 'ring_lathe':
      return widthMm;
    case 'box':
      return widthMm * 0.6;
    default:
      return Math.max(widthMm * 0.3, 2);
  }
}

function scaledProfile(obs: ObjectObservation): ObservedProfile {
  let p = obs.profile;
  const d = obs.dimensionsMm;
  if (d?.length && Math.abs(d.length - p.lengthMm) > 1e-6) p = rescaleProfile(p, d.length);
  if (d?.width && Math.abs(d.width - profileMaxWidth(p)) > 1e-6) p = setProfileWidth(p, d.width);
  return p;
}

/** Best score per class, best first (the recogniser may list a class several times). */
function uniqueByClass(candidates: readonly ClassCandidate[]): ClassCandidate[] {
  const best = new Map<string, ClassCandidate>();
  for (const c of candidates) {
    const known = best.get(c.classId);
    if (!known || c.score > known.score) best.set(c.classId, c);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** Length, width, thickness (mm) of a model: the tool frame has the axis on Y, the width on X, the thickness on Z. */
export function dimensionsOf(model: ToolModel): {
  length: number;
  width: number;
  thickness: number;
} {
  const size = sizeOf(model.bounds);
  return { length: size[1], width: size[0], thickness: size[2] };
}

function thicknessOf(model: ToolModel): number {
  return sizeOf(model.bounds)[2];
}

export function fitObject(obs: ObjectObservation, decision: DraftDecision = {}): FittedObject {
  const profile = scaledProfile(obs);
  const colors = contiguousSegments(obs.colors);
  const width = profileMaxWidth(profile);

  const tryClass = (classId: string): ClassFit | null => {
    if (!hasToolClass(classId)) return null;
    return fitClassToProfile(classId, profile, {
      fixed: decision.fixed ?? {},
      start: decision.start ?? {},
    });
  };

  let chosen: ClassFit | null = null;
  const alternatives: FittedObject['alternatives'] = [];
  if (decision.classId === undefined) {
    const pool = uniqueByClass(obs.candidates)
      .filter((c) => c.score >= MIN_CANDIDATE_SCORE)
      .slice(0, 3);
    let bestValue = -Infinity;
    for (const c of pool) {
      const f = tryClass(c.classId);
      if (!f) continue;
      alternatives.push({ classId: c.classId, iou: f.iou, score: c.score });
      // a fit below MIN_FIT_IOU is no candidate at all; the best of the others wins
      const value = 0.65 * f.iou + 0.35 * c.score;
      if (f.iou >= MIN_FIT_IOU && value > bestValue) {
        chosen = f;
        bestValue = value;
      }
    }
  } else if (decision.classId !== null) {
    chosen = tryClass(decision.classId);
    if (!chosen) throw new ToolInputError(`unknown tool class: ${decision.classId}`);
  }

  if (chosen) {
    let model = generate(chosen.classId, chosen.params, 0);
    let modelLod1 = generate(chosen.classId, chosen.params, 1);
    let zScale = 1;
    const wantThickness = obs.dimensionsMm?.thickness;
    if (wantThickness) {
      zScale = clamp(wantThickness / Math.max(thicknessOf(model), 1e-6), 0.2, 5);
      model = scaleMeshZ(model, zScale);
      modelLod1 = scaleMeshZ(modelLod1, zScale);
    }
    const partColors = {
      ...colorsFromSegments(model, colors, chosen.flipped),
      ...decision.partColors,
    };
    model = recolorModel(model, partColors);
    modelLod1 = recolorModel(modelLod1, partColors);
    return {
      classId: chosen.classId,
      params: chosen.params,
      fit: {
        method: 'class-profile',
        iou: chosen.iou,
        confidence: clamp(chosen.iou, 0, 1),
        view: chosen.view,
        flipped: chosen.flipped,
        zScale,
      },
      partColors,
      dimensionsMm: { ...dimensionsOf(model), source: obs.dimensionSource },
      profile,
      model,
      modelLod1,
      alternatives,
    };
  }

  const thickness = genericThickness(obs, width);
  const genericOptions = { thicknessMm: thickness, colors };
  let model = buildGenericLoft(profile, genericOptions, 0);
  let modelLod1 = buildGenericLoft(profile, genericOptions, 1);
  const partColors = { ...decision.partColors };
  if (Object.keys(partColors).length > 0) {
    model = recolorModel(model, partColors);
    modelLod1 = recolorModel(modelLod1, partColors);
  }
  return {
    classId: null,
    params: {},
    fit: {
      method: 'generic-loft',
      iou: 0.9,
      confidence: 0.5,
      view: 'front',
      flipped: false,
      zScale: 1,
    },
    partColors,
    dimensionsMm: { ...dimensionsOf(model), source: obs.dimensionSource },
    profile,
    model,
    modelLod1,
    alternatives,
  };
}

/** The observation a built model would produce: used by tests and to build recognition prototypes. */
export function observeModel(
  model: ToolModel,
  view: 'front' | 'side' = 'front',
  stations = 12,
): ObservedProfile {
  const y0 = model.bounds.min[1];
  const y1 = model.bounds.max[1];
  const raw: { t: number; lo: number; hi: number }[] = [];
  for (let i = 0; i < stations; i++) {
    const t = (i + 0.5) / stations;
    const e = sectionExtentsAt(model.parts, y0 + t * (y1 - y0));
    if (e.maxX < e.minX) raw.push({ t, lo: 0, hi: 0 });
    else raw.push(view === 'front' ? { t, lo: e.minX, hi: e.maxX } : { t, lo: e.minZ, hi: e.maxZ });
  }
  const half = Math.floor(stations / 2);
  const a = raw.slice(0, half).reduce((s, r) => s + r.hi - r.lo, 0);
  const b = raw.slice(half).reduce((s, r) => s + r.hi - r.lo, 0);
  const ordered =
    a >= b
      ? raw
      : [...raw].reverse().map((r, i) => ({ t: (i + 0.5) / stations, lo: r.lo, hi: r.hi }));
  return { lengthMm: y1 - y0, stations: ordered };
}
