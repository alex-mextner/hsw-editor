/** Input handling of the dimension request form: initial values and validation against field limits. */
import type { DimensionField } from '@/api/requests.ts';
import { parseLength } from './calibrationMath.ts';

export type FieldError = 'invalid' | 'min' | 'max';

export interface DimensionInput {
  /** Valid, non-empty entries keyed by param name: what `setParams` will set. */
  readonly values: Readonly<Record<string, number>>;
  readonly errors: ReadonlyMap<string, FieldError>;
}

export function formatDimension(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** What the field starts with: the item's current value, else the fitted one, else the suggestion. */
export function initialText(field: DimensionField, current: number | undefined): string {
  const value = current ?? field.fitted ?? field.suggested;
  return value === undefined ? '' : formatDimension(value);
}

/** Empty entries are left out (the param stays as it is); anything else must be a number within limits. */
export function parseDimensionInput(
  fields: readonly DimensionField[],
  texts: ReadonlyMap<string, string>,
): DimensionInput {
  const values: Record<string, number> = {};
  const errors = new Map<string, FieldError>();
  for (const field of fields) {
    const text = texts.get(field.key) ?? '';
    if (text.trim() === '') continue;
    const value = parseLength(text);
    if (value === null) errors.set(field.key, 'invalid');
    else if (field.min !== undefined && value < field.min) errors.set(field.key, 'min');
    else if (field.max !== undefined && value > field.max) errors.set(field.key, 'max');
    else values[field.key] = value;
  }
  return { values, errors };
}
