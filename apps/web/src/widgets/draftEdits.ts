/**
 * Pure edit arithmetic of the dimension widget. The working copy of an item's params is just a
 * `{ key: value }` override map: a key that is absent means "the element's default".
 */
import type { ParamDef } from '@hsw-editor/bank';

export type ParamMap = Readonly<Record<string, number>>;

export interface ParamsChange {
  readonly set: Record<string, number>;
  readonly unset: string[];
}

export function valueOf(def: ParamDef, params: ParamMap): number {
  return params[def.key] ?? def.default;
}

/** Decimal places of `step` (0.25 -> 2), so stepping never leaves float noise like 12.600000000000001. */
function decimalsOf(step: number): number {
  const text = String(step);
  if (text.includes('e-')) return Number(text.split('e-')[1] ?? 0);
  return text.split('.')[1]?.length ?? 0;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Clamps into [min, max]; counts are whole numbers, other values keep 4 decimals at most. */
export function normalizeValue(def: ParamDef, value: number): number {
  const clamped = Math.min(def.max, Math.max(def.min, value));
  return def.unit === 'count'
    ? Math.round(clamped)
    : round(clamped, Math.max(4, decimalsOf(def.step)));
}

/** One stepper press: `direction` is +1/-1, `multiplier` 10 for coarse (Shift) or 0.1 for fine (Alt). */
export function stepValue(def: ParamDef, value: number, direction: 1 | -1, multiplier = 1): number {
  const step = def.unit === 'count' ? Math.max(1, def.step * multiplier) : def.step * multiplier;
  const decimals = Math.max(decimalsOf(def.step), decimalsOf(step));
  return normalizeValue(def, round(value + direction * step, decimals));
}

/**
 * Sets `def.key` to `value` (normalised). With `keepAspect`, every other millimetre param is scaled
 * by the same ratio (relative to `base`) and clamped into its own range, so the object keeps its proportions.
 */
export function withValue(
  defs: readonly ParamDef[],
  working: ParamMap,
  def: ParamDef,
  value: number,
  keepAspect: boolean,
  base: ParamMap = working,
): Record<string, number> {
  const next = normalizeValue(def, value);
  const result: Record<string, number> = { ...working, [def.key]: next };
  // Proportions come from `base` (the params before the edit began), not from the previous live
  // preview: clamping a small intermediate value would otherwise lose the ratio for good.
  const before = valueOf(def, base);
  if (!keepAspect || def.unit !== 'mm' || before <= 0 || next === before) return result;
  const ratio = next / before;
  for (const other of defs) {
    if (other.key === def.key || other.unit !== 'mm') continue;
    result[other.key] = normalizeValue(other, valueOf(other, base) * ratio);
  }
  return result;
}

/** Overrides minus one key: the field falls back to the element default. */
export function withoutValue(working: ParamMap, key: string): Record<string, number> {
  return Object.fromEntries(Object.entries(working).filter(([other]) => other !== key));
}

/** What committing `working` over `base` would change; null when they are the same. */
export function diffParams(base: ParamMap, working: ParamMap): ParamsChange | null {
  const set: Record<string, number> = {};
  for (const [key, value] of Object.entries(working)) {
    if (base[key] !== value) set[key] = value;
  }
  const unset = Object.keys(base).filter((key) => !(key in working));
  return Object.keys(set).length === 0 && unset.length === 0 ? null : { set, unset };
}
