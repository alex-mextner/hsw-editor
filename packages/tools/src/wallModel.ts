/**
 * What the wall editor needs from a generator to draw a tool on the wall: which class draws a wall tool, the
 * class parameters that reach a wanted bounding box (`width` x `length` x `thickness` of the dimension widget),
 * the holding summary a holder is matched against and a stable hash of "this class with these values".
 *
 * Pure and dependency-free (no Node, no DOM): it runs in the server's asset builder, in the browser worker that
 * regenerates a model when a dimension changes, and in tests.
 */
import { type Bounds, clamp } from './math.ts';
import { DIM_TOLERANCE_MM, type HoldingSummary, type ToolDims } from './dims.ts';
import type { ToolModel } from './model.ts';
import { type AnyToolClass, generate, getToolClass, listToolClasses } from './registry.ts';
import { type AnyValues, resolveValues } from './params.ts';
import { realismOf, realismProblems } from './realism.ts';

export function boundsDims(bounds: Bounds): ToolDims {
  return {
    x: bounds.max[0] - bounds.min[0],
    y: bounds.max[1] - bounds.min[1],
    z: bounds.max[2] - bounds.min[2],
  };
}

/** Centre of the bounds in the tool frame (origin on the axis at the butt, +Y towards the working end). */
export function boundsCentre(bounds: Bounds): ToolDims {
  return {
    x: (bounds.max[0] + bounds.min[0]) / 2,
    y: (bounds.max[1] + bounds.min[1]) / 2,
    z: (bounds.max[2] + bounds.min[2]) / 2,
  };
}

export function holdingSummary(model: ToolModel): HoldingSummary {
  const { holding } = model;
  const hang = holding.hang;
  return {
    lengthMm: holding.lengthMm,
    hang:
      hang === null
        ? null
        : {
            point: [hang.point[0], hang.point[1], hang.point[2]],
            kind: hang.kind,
            ...(hang.diameterMm === undefined ? {} : { diameterMm: hang.diameterMm }),
          },
    maxSection: { w: holding.maxSection.w, t: holding.maxSection.t, r: holding.maxSection.r },
    dims: { ...holding.dims },
  };
}

// ---- hashing -----------------------------------------------------------------------------------------

/** cyrb53: a well-mixed 53-bit string hash that needs no crypto API (workers, tests and Node alike). */
function cyrb53(text: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Canonical text of resolved class values: sorted keys, numbers rounded to micrometres. */
export function valuesKey(values: Readonly<Record<string, number | string>>): string {
  return Object.keys(values)
    .sort()
    .map((key) => {
      const value = values[key];
      return `${key}=${typeof value === 'number' ? Math.round(value * 1000) / 1000 : value}`;
    })
    .join(',');
}

/** 16 hex characters naming "this class with these (resolved) values"; the cache key of a generated model. */
export function paramHash(
  classId: string,
  values: Readonly<Record<string, number | string>>,
): string {
  const text = `${classId}|${valuesKey(values)}`;
  return [cyrb53(text, 0), cyrb53(text, 0x9e3779b9)]
    .map((part) => part.toString(16).padStart(8, '0').slice(-8))
    .join('');
}

// ---- class lookup ------------------------------------------------------------------------------------

/**
 * The generator that draws a wall tool of bank class `bankClass`: the class whose id is the bank id, else the
 * first registered class declaring it as its `bankClass`; the coarser classes (`broader`) are tried in order.
 * Undefined when nothing draws it (the editor keeps a box then).
 */
export function generatorForBankClass(
  bankClass: string,
  broader: readonly string[] = [],
): AnyToolClass | undefined {
  const all = listToolClasses();
  for (const id of [bankClass, ...broader]) {
    const own = all.find((cls) => cls.id === id && cls.bankClass === id);
    if (own) return own;
    const declared = all.find((cls) => cls.bankClass === id);
    if (declared) return declared;
  }
  return undefined;
}

// ---- reaching a bounding box --------------------------------------------------------------------------

const AXES = ['y', 'x', 'z'] as const;
type Axis = (typeof AXES)[number];

const MAX_ROUNDS = 8;

export interface SolvedDims {
  /** Resolved class values (every parameter, clamped to the schema). */
  values: AnyValues;
  /** Bounding box the values actually produce at LOD1. */
  dims: ToolDims;
  /** Every wanted axis is within `DIM_TOLERANCE_MM`; false when the class cannot be that size. */
  reached: boolean;
}

function measure(classId: string, values: AnyValues): ToolDims {
  return boundsDims(generate(classId, values, 1).bounds);
}

interface Driver {
  key: string;
  /** mm of the box per mm of the parameter, per axis. */
  slope: ToolDims;
}

function numericDimensionKeys(cls: AnyToolClass): string[] {
  return Object.entries(cls.schema)
    .filter(
      ([, spec]) =>
        spec.kind === 'num' && spec.dimension && spec.unit === 'mm' && spec.max > spec.min,
    )
    .map(([key]) => key);
}

function probeSlopes(
  classId: string,
  cls: AnyToolClass,
  values: AnyValues,
  dims: ToolDims,
): Driver[] {
  const out: Driver[] = [];
  for (const key of numericDimensionKeys(cls)) {
    const spec = cls.schema[key];
    const current = values[key];
    if (spec?.kind !== 'num' || typeof current !== 'number') continue;
    const h = Math.max(spec.step, (spec.max - spec.min) * 0.04);
    let probe = clamp(current + h, spec.min, spec.max);
    if (Math.abs(probe - current) < 1e-6) probe = clamp(current - h, spec.min, spec.max);
    if (Math.abs(probe - current) < 1e-6) continue;
    const moved = measure(classId, { ...values, [key]: probe });
    const dv = probe - current;
    out.push({
      key,
      slope: {
        x: (moved.x - dims.x) / dv,
        y: (moved.y - dims.y) / dv,
        z: (moved.z - dims.z) / dv,
      },
    });
  }
  return out;
}

/** How close to the best driver of an axis another parameter must be to share the work: lengths of one tool grow together. */
const GROUP_SHARE = 0.4;

/**
 * The parameters that move each wanted axis: the most selective one (large slope on it, small on the others) and every other
 * that is nearly as selective, none taken twice. A screwdriver's length is its handle AND its blade, so both grow together.
 */
function assignDrivers(drivers: readonly Driver[], axes: readonly Axis[]): Map<Axis, Driver[]> {
  const taken = new Set<string>();
  const chosen = new Map<Axis, Driver[]>();
  const score = (driver: Driver, axis: Axis): number => {
    const own = Math.abs(driver.slope[axis]);
    if (own < 0.05) return 0;
    return (own * own) / Math.hypot(driver.slope.x, driver.slope.y, driver.slope.z);
  };
  for (const axis of axes) {
    const ranked = drivers
      .filter((driver) => !taken.has(driver.key))
      .map((driver) => ({ driver, score: score(driver, axis) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) continue;
    const group = ranked
      .filter((entry) => entry.score >= best.score * GROUP_SHARE)
      .map((e) => e.driver);
    for (const driver of group) taken.add(driver.key);
    chosen.set(axis, group);
  }
  return chosen;
}

/** Overall size a real tool of the class can have on each axis (`REALISM`); axes without a rule are free. */
function realisticTarget(classId: string, axis: Axis, wanted: number): number {
  const rule = realismOf(classId);
  const range = axis === 'y' ? rule?.length : axis === 'x' ? rule?.width : rule?.thickness;
  return range ? clamp(wanted, range.min, range.max) : wanted;
}

/**
 * Class values whose model has the wanted box (`wanted` axes that are undefined are left alone). One probe build per dimension
 * parameter picks the parameters that move each axis, they are scaled together (proportions stay those of the class: a longer
 * screwdriver gets a longer handle and a longer blade), then a secant iteration closes the gap. The wanted size is first held to
 * what a real tool of the class measures (`REALISM`), values are clamped to the schema, and a result whose proportions are not
 * real falls back to the unchanged class: an impossible size ends at the nearest real one (`reached: false`).
 */
export function solveToolDims(
  classId: string,
  base: Readonly<Record<string, number | string>>,
  wanted: Partial<ToolDims>,
): SolvedDims {
  const cls = getToolClass(classId);
  const start = resolveValues(cls.schema, base) as AnyValues;
  let values = start;
  let dims = measure(classId, values);
  const axes = AXES.filter((axis) => wanted[axis] !== undefined);
  const target: Partial<ToolDims> = {};
  for (const axis of axes)
    target[axis] = realisticTarget(classId, axis, wanted[axis] ?? dims[axis]);
  const asked = axes.every((axis) => target[axis] === wanted[axis]);
  const within = (): boolean =>
    axes.every((axis) => Math.abs((target[axis] ?? dims[axis]) - dims[axis]) <= DIM_TOLERANCE_MM);
  if (axes.length === 0 || within()) return { values, dims, reached: asked };

  const groups = assignDrivers(probeSlopes(classId, cls, values, dims), axes);
  for (let round = 0; round < MAX_ROUNDS && !within(); round++) {
    let moved = false;
    for (const axis of axes) {
      const group = groups.get(axis);
      const goal = target[axis];
      if (!group || goal === undefined) continue;
      const error = goal - dims[axis];
      if (Math.abs(error) <= DIM_TOLERANCE_MM * 0.4) continue;
      // k scales every parameter of the group by the same factor: k * sum(value * slope) = error.
      let lever = 0;
      for (const driver of group) {
        const current = values[driver.key];
        if (typeof current === 'number') lever += current * driver.slope[axis];
      }
      if (Math.abs(lever) < 1e-9) continue;
      const k = error / lever;
      const nextValues: AnyValues = { ...values };
      for (const driver of group) {
        const spec = cls.schema[driver.key];
        const current = values[driver.key];
        if (spec?.kind !== 'num' || typeof current !== 'number') continue;
        // A part is also held to what a real one measures (a 320 mm screwdriver has a 120 mm handle, not a 160 mm one);
        // the rounds that follow give what it cannot take to the parts that still can.
        const real = realismOf(classId)?.dims?.[driver.key];
        nextValues[driver.key] = clamp(
          current * (1 + k),
          Math.max(spec.min, real?.min ?? spec.min),
          Math.min(spec.max, real?.max ?? spec.max),
        );
      }
      const nextDims = measure(classId, nextValues);
      for (const driver of group) {
        const before = values[driver.key];
        const after = nextValues[driver.key];
        if (
          typeof before !== 'number' ||
          typeof after !== 'number' ||
          Math.abs(after - before) < 1e-6
        )
          continue;
        // Secant update of the slope this parameter really has around here.
        driver.slope = {
          x: (nextDims.x - dims.x) / (after - before) / group.length,
          y: (nextDims.y - dims.y) / (after - before) / group.length,
          z: (nextDims.z - dims.z) / (after - before) / group.length,
        };
      }
      const changed = group.some((driver) => nextValues[driver.key] !== values[driver.key]);
      values = nextValues;
      dims = nextDims;
      moved = moved || changed;
    }
    if (!moved) break;
  }
  const model = generate(classId, values, 1);
  if (realismProblems(classId, model.bounds, model.holding).length > 0) {
    return { values: start, dims: measure(classId, start), reached: false };
  }
  return { values, dims, reached: within() && asked };
}

/** A model for a wall tool: the values that reach `wanted`, both LODs, the hash that names them. */
export interface WallToolModel {
  classId: string;
  values: AnyValues;
  hash: string;
  reached: boolean;
  lod0: ToolModel;
  lod1: ToolModel;
}

export function buildWallToolModel(
  classId: string,
  base: Readonly<Record<string, number | string>>,
  wanted: Partial<ToolDims> = {},
): WallToolModel {
  const solved = solveToolDims(classId, base, wanted);
  return {
    classId,
    values: solved.values,
    hash: paramHash(classId, solved.values),
    reached: solved.reached,
    lod0: generate(classId, solved.values, 0),
    lod1: generate(classId, solved.values, 1),
  };
}
