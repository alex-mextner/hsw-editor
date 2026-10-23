/** Parameter values of a tool class in the detail page: defaults, presets, clamping and comparison. Pure. */
import type { ParamSpec, ParamValues, ToolClassInfo } from './api.ts';

/** The class defaults, overlaid with the preset's values when one is given. */
export function valuesFor(info: ToolClassInfo, presetId: string | null): ParamValues {
  const out: Record<string, number | string> = {};
  for (const [key, spec] of Object.entries(info.schema)) out[key] = spec.def;
  const preset = presetId === null ? undefined : info.presets.find((entry) => entry.id === presetId);
  return { ...out, ...preset?.values };
}

export function clampToSpec(spec: ParamSpec, value: number | string): number | string {
  if (spec.kind === 'num') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return spec.def;
    return Math.min(spec.max, Math.max(spec.min, n));
  }
  if (spec.kind === 'choice') return spec.options.includes(String(value)) ? String(value) : spec.def;
  return /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : spec.def;
}

/** `values` with one parameter changed and clamped to the schema. */
export function withParam(
  info: ToolClassInfo,
  values: ParamValues,
  key: string,
  value: number | string,
): ParamValues {
  const spec = info.schema[key];
  return spec ? { ...values, [key]: clampToSpec(spec, value) } : values;
}

/** The first preset whose values match `values` (all of its keys), or null for a custom combination. */
export function matchingPreset(info: ToolClassInfo, values: ParamValues): string | null {
  const base = valuesFor(info, null);
  for (const preset of info.presets) {
    const candidate = { ...base, ...preset.values };
    if (Object.keys(candidate).every((key) => candidate[key] === values[key])) return preset.id;
  }
  return null;
}

/** Whether `values` differ from the class defaults of `presetId` (the preset the page started from). */
export function isCustomized(info: ToolClassInfo, values: ParamValues, presetId: string | null): boolean {
  const base = valuesFor(info, presetId);
  return Object.keys(base).some((key) => base[key] !== values[key]);
}

/** Numbers print without trailing zeros: 12 stays 12, 12.5 stays 12.5, 0.30000000000000004 becomes 0.3. */
export function formatValue(value: number): string {
  return `${Number(value.toFixed(3))}`;
}
