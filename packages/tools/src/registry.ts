/**
 * Typed tool-class registry. A class declares its parameter schema (ranges and defaults in mm), named
 * presets (real sizes) and a `build` that returns named parts; `generate` resolves/clamps the values,
 * runs `build`, and derives bounds and the holding interface.
 */
import {
  type AnyValues,
  type Label,
  type ParamValue,
  type Schema,
  type Values,
  defaultValues,
  resolveValues,
} from './params.ts';
import {
  type BuiltTool,
  type Lod,
  type ToolModel,
  boundsOfParts,
  buildHolding,
  totalTriangles,
} from './model.ts';

export type FamilyId =
  | 'drivers'
  | 'pliers'
  | 'wrenches'
  | 'striking'
  | 'cutting'
  | 'measuring'
  | 'power'
  | 'workshop';

export const FAMILY_LABELS: Record<FamilyId, Label> = {
  drivers: { en: 'Screwdrivers and bits', ru: 'Отвёртки и биты' },
  pliers: { en: 'Pliers, snips and clamps', ru: 'Плоскогубцы, кусачки и струбцины' },
  wrenches: { en: 'Wrenches and sockets', ru: 'Ключи и головки' },
  striking: { en: 'Hammers, chisels, files and saws', ru: 'Молотки, стамески, напильники и пилы' },
  cutting: { en: 'Knives and scissors', ru: 'Ножи и ножницы' },
  measuring: { en: 'Measuring and marking', ru: 'Измерение и разметка' },
  power: { en: 'Power, electronics and consumables', ru: 'Электро, электроника и расходники' },
  workshop: { en: 'Workshop supplies', ru: 'Расходники мастерской' },
};

/** Context handed to `build`: level of detail and helpers to scale tessellation with it. */
export interface BuildCtx {
  lod: Lod;
  /** Segment count: `hi` at LOD0, `lo` at LOD1. */
  seg(hi: number, lo: number): number;
  /** True at LOD0: build the small details (knurling, threads, text, fine fins). */
  detail: boolean;
}

export interface Preset<S extends Schema> {
  id: string;
  label: Label;
  values: Partial<Values<S>>;
}

export interface ToolClassDef<S extends Schema = Schema> {
  id: string;
  family: FamilyId;
  name: Label;
  /** Class id in the bank vocabulary (`packages/bank` toolClasses) used for `fitsTool` and holder search. */
  bankClass: string;
  /** Words used for recognition prompts and search (`a photo of a {keyword}`). */
  keywords: { en: readonly string[]; ru: readonly string[] };
  schema: S;
  presets: readonly Preset<S>[];
  build(p: Values<S>, ctx: BuildCtx): BuiltTool;
}

export type AnyToolClass = ToolClassDef<Schema>;

const classes = new Map<string, AnyToolClass>();

export function defineToolClass<S extends Schema>(def: ToolClassDef<S>): ToolClassDef<S> {
  if (classes.has(def.id)) throw new Error(`tool class registered twice: ${def.id}`);
  classes.set(def.id, def as unknown as AnyToolClass);
  return def;
}

export function listToolClasses(): AnyToolClass[] {
  return [...classes.values()];
}

export function getToolClass(id: string): AnyToolClass {
  const c = classes.get(id);
  if (!c) throw new Error(`unknown tool class: ${id}`);
  return c;
}

export function hasToolClass(id: string): boolean {
  return classes.has(id);
}

export function classDefaults(id: string): AnyValues {
  return defaultValues(getToolClass(id).schema) as AnyValues;
}

export function makeCtx(lod: Lod): BuildCtx {
  return { lod, seg: (hi, lo) => (lod === 0 ? hi : lo), detail: lod === 0 };
}

/** Resolve a preset id into parameter values (merged over the defaults). */
export function presetValues(classId: string, presetId: string): AnyValues {
  const cls = getToolClass(classId);
  const preset = cls.presets.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown preset ${presetId} of ${classId}`);
  return { ...(defaultValues(cls.schema) as AnyValues), ...(preset.values as AnyValues) };
}

/** Build a model. `overrides` are clamped to the schema ranges; missing keys take the defaults. */
export function generate(
  classId: string,
  overrides: Readonly<Record<string, ParamValue>> = {},
  lod: Lod = 0,
): ToolModel {
  const cls = getToolClass(classId);
  const params = resolveValues(cls.schema, overrides) as AnyValues;
  const built = cls.build(params as never, makeCtx(lod));
  const names = new Set<string>();
  for (const part of built.parts) {
    if (names.has(part.name)) throw new Error(`${classId}: duplicate part name ${part.name}`);
    names.add(part.name);
  }
  const bounds = boundsOfParts(built.parts);
  return {
    classId,
    params,
    lod,
    parts: built.parts,
    bounds,
    holding: buildHolding(built, bounds, lod === 0 ? 2 : 4),
    triangles: totalTriangles(built.parts),
  };
}
