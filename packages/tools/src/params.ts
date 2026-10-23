/**
 * Parameter schema of a tool class. Declared once with `num` / `choice` / `color`; the value types are
 * derived (`Values<S>`) so generators are fully typed, and the same schema drives the UI widgets and the
 * clamping of values that come from the API or from a photo fit.
 */
import { clamp } from './math.ts';

export interface Label {
  en: string;
  ru: string;
}

export interface NumSpec {
  kind: 'num';
  min: number;
  max: number;
  def: number;
  step: number;
  unit: 'mm' | 'deg' | 'count' | 'ratio';
  label: Label;
  /** Fitting hint: this parameter is a real-world dimension the user can type in. */
  dimension: boolean;
}

export interface ChoiceSpec<T extends string = string> {
  kind: 'choice';
  options: readonly T[];
  def: T;
  label: Label;
}

export interface ColorSpec {
  kind: 'color';
  def: string;
  label: Label;
}

export type ParamSpec = NumSpec | ChoiceSpec | ColorSpec;
export type Schema = Record<string, ParamSpec>;

export type Values<S extends Schema> = {
  [K in keyof S]: S[K] extends NumSpec ? number : S[K] extends ChoiceSpec<infer T> ? T : string;
};

export type ParamValue = number | string;
export type AnyValues = Record<string, ParamValue>;

export function num(
  label: Label,
  def: number,
  min: number,
  max: number,
  options: { step?: number; unit?: NumSpec['unit']; dimension?: boolean } = {},
): NumSpec {
  if (!(min <= def && def <= max))
    throw new Error(`num(${label.en}): default ${def} outside ${min}..${max}`);
  return {
    kind: 'num',
    min,
    max,
    def,
    step: options.step ?? (max - min > 20 ? 0.5 : 0.1),
    unit: options.unit ?? 'mm',
    label,
    dimension: options.dimension ?? (options.unit ?? 'mm') === 'mm',
  };
}

export function choice<const T extends string>(
  label: Label,
  options: readonly T[],
  def: T,
): ChoiceSpec<T> {
  if (!options.includes(def)) throw new Error(`choice(${label.en}): default ${def} not in options`);
  return { kind: 'choice', options, def, label };
}

export function color(label: Label, def: string): ColorSpec {
  return { kind: 'color', def, label };
}

export const L = (en: string, ru: string): Label => ({ en, ru });

export function defaultValues<S extends Schema>(schema: S): Values<S> {
  const out: AnyValues = {};
  for (const [key, spec] of Object.entries(schema)) out[key] = spec.def;
  return out as Values<S>;
}

/** Fill defaults, clamp numbers to their range, reject unknown choices (falls back to the default). */
export function resolveValues<S extends Schema>(
  schema: S,
  input: Readonly<Record<string, ParamValue>> = {},
): Values<S> {
  const out: AnyValues = {};
  for (const [key, spec] of Object.entries(schema)) {
    const v = input[key];
    if (spec.kind === 'num')
      out[key] =
        typeof v === 'number' && Number.isFinite(v) ? clamp(v, spec.min, spec.max) : spec.def;
    else if (spec.kind === 'choice')
      out[key] = typeof v === 'string' && spec.options.includes(v) ? v : spec.def;
    else out[key] = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : spec.def;
  }
  return out as Values<S>;
}
