/**
 * Declarative description of parametric element families (`generators/families.json`) and their
 * expansion into concrete elements ("rungs" of a size ladder). Pure: no I/O, usable in tests and in
 * the pipeline. A family points at an OpenSCAD generator and a `part` of it; every rung is one
 * parameter set rendered by OpenSCAD and ingested as its own `generated: true` element.
 */
import { z } from 'zod';
import {
  LocalizedTextSchema,
  MountingSchema,
  ParamDefSchema,
  PrintNotesSchema,
  type FitsTool,
  type LocalizedText,
  type ParamDef,
} from './schema.ts';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** Range of an object dimension derived from a generator parameter: [param + minDelta, param + maxDelta]. */
const DerivedRangeSchema = z.object({
  param: z.string(),
  minDelta: z.number(),
  maxDelta: z.number(),
});
const FixedRangeSchema = z.object({ min: z.number(), max: z.number() });

export const FamilyFitsSchema = z.object({
  toolClass: slug,
  /** Capacity: a fixed count or the value of a generator parameter. */
  capacity: z.union([z.number().int().positive(), z.object({ param: z.string() })]).optional(),
  dims: z.record(z.string(), z.union([DerivedRangeSchema, FixedRangeSchema])).optional(),
  notes: LocalizedTextSchema.optional(),
});
export type FamilyFits = z.infer<typeof FamilyFitsSchema>;

export const FamilySpecSchema = z.object({
  id: slug,
  /** File under packages/bank/generators. */
  generator: z.string().regex(/^[\w.-]+\.scad$/),
  /** Value of the OpenSCAD `part` variable selecting the module. */
  part: z.string(),
  /** Bumped when the SCAD of this part changes in a way that alters geometry; part of the cache key. */
  version: z.number().int().positive(),
  category: z.string(),
  toolClasses: z.array(slug),
  /** `{key}` placeholders are replaced with the rung's parameter values. */
  nameTemplate: LocalizedTextSchema,
  variantTemplate: LocalizedTextSchema,
  description: LocalizedTextSchema.optional(),
  tags: z.object({ ru: z.array(z.string()), en: z.array(z.string()) }),
  params: z.array(ParamDefSchema).min(1),
  /** Cartesian product of these value lists = the rungs. Every key must be a declared param. */
  grid: z.record(z.string(), z.array(z.number()).min(1)),
  /** Values applied to every rung (declared params not in the grid; default = ParamDef.default). */
  fixed: z.record(z.string(), z.number()).optional(),
  /** Rungs (subset of the grid) to skip, e.g. nonsensical combinations. */
  exclude: z.array(z.record(z.string(), z.number())).optional(),
  fits: z.array(FamilyFitsSchema),
  mounting: MountingSchema.pick({ kind: true }),
  printNotes: PrintNotesSchema.optional(),
  /** `origin`: the generator models around the mount point (0,0); `back-bbox`: centre on the wall-facing slab. */
  anchor: z.enum(['origin', 'back-bbox']),
});
export type FamilySpec = z.infer<typeof FamilySpecSchema>;

export const FamilyFileSchema = z.object({
  /** Licence statement for everything generated from this file (project original). */
  attribution: z.string(),
  families: z.array(FamilySpecSchema).min(1),
});
export type FamilyFile = z.infer<typeof FamilyFileSchema>;

export interface Rung {
  /** Unique, stable element id. */
  id: string;
  values: Record<string, number>;
  name: LocalizedText;
  variantLabel: LocalizedText;
  fitsTool: FitsTool[];
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

function fill(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const v = values[key];
    if (v === undefined) throw new Error(`template placeholder {${key}} has no value`);
    return formatNumber(v);
  });
}

function rungSlug(familyId: string, grid: Record<string, number>): string {
  const parts = Object.entries(grid).map(([k, v]) => `${k}${formatNumber(v).replace('.', 'p')}`);
  return `${familyId}-${parts.join('-')}`
    .replace(/([A-Z])/g, (c) => c.toLowerCase())
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-');
}

/** Cartesian product of `grid`, in declaration order, minus `exclude`. */
function* product(grid: Record<string, number[]>): Generator<Record<string, number>> {
  const keys = Object.keys(grid);
  const walk = function* (
    i: number,
    acc: Record<string, number>,
  ): Generator<Record<string, number>> {
    const key = keys[i];
    if (key === undefined) {
      yield { ...acc };
      return;
    }
    for (const value of grid[key] ?? []) yield* walk(i + 1, { ...acc, [key]: value });
  };
  yield* walk(0, {});
}

function paramByKey(params: readonly ParamDef[]): Map<string, ParamDef> {
  return new Map(params.map((p) => [p.key, p]));
}

/** Throws with a precise message when the spec is not self-consistent. */
export function checkFamily(spec: FamilySpec): void {
  const params = paramByKey(spec.params);
  if (params.size !== spec.params.length) throw new Error(`${spec.id}: duplicate param keys`);
  const known = (key: string, where: string): ParamDef => {
    const p = params.get(key);
    if (!p) throw new Error(`${spec.id}: ${where} references undeclared param ${key}`);
    return p;
  };
  for (const [key, values] of Object.entries(spec.grid)) {
    const p = known(key, 'grid');
    for (const v of values) {
      if (v < p.min || v > p.max)
        throw new Error(`${spec.id}: grid ${key}=${v} outside [${p.min}, ${p.max}]`);
    }
  }
  for (const key of Object.keys(spec.fixed ?? {})) known(key, 'fixed');
  for (const fit of spec.fits) {
    if (typeof fit.capacity === 'object') known(fit.capacity.param, 'fits.capacity');
    for (const range of Object.values(fit.dims ?? {}))
      if ('param' in range) known(range.param, 'fits.dims');
  }
}

export function expandFamily(spec: FamilySpec): Rung[] {
  checkFamily(spec);
  const rungs: Rung[] = [];
  const excluded = spec.exclude ?? [];
  for (const gridValues of product(spec.grid)) {
    if (excluded.some((rule) => Object.entries(rule).every(([k, v]) => gridValues[k] === v)))
      continue;
    const values: Record<string, number> = {};
    for (const p of spec.params) values[p.key] = p.default;
    Object.assign(values, spec.fixed, gridValues);
    const fitsTool: FitsTool[] = spec.fits.map((fit) => {
      const out: FitsTool = { toolClass: fit.toolClass };
      if (fit.capacity !== undefined) {
        out.capacity =
          typeof fit.capacity === 'number'
            ? fit.capacity
            : Math.round(values[fit.capacity.param] ?? 1);
      }
      if (fit.dims) {
        out.dims = {};
        for (const [key, range] of Object.entries(fit.dims)) {
          if ('param' in range) {
            const base = values[range.param] ?? 0;
            out.dims[key] = { min: Math.max(0, base + range.minDelta), max: base + range.maxDelta };
          } else {
            out.dims[key] = range;
          }
        }
      }
      if (fit.notes) out.notes = fit.notes;
      return out;
    });
    rungs.push({
      id: rungSlug(spec.id, gridValues),
      values,
      name: { ru: fill(spec.nameTemplate.ru, values), en: fill(spec.nameTemplate.en, values) },
      variantLabel: {
        ru: fill(spec.variantTemplate.ru, values),
        en: fill(spec.variantTemplate.en, values),
      },
      fitsTool,
    });
  }
  const ids = new Set<string>();
  for (const r of rungs) {
    if (ids.has(r.id)) throw new Error(`${spec.id}: duplicate rung id ${r.id}`);
    ids.add(r.id);
  }
  return rungs;
}
