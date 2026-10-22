/**
 * Length units of the dimension widgets. The wall document and every param stay in millimetres;
 * the unit only changes how numbers are shown and typed.
 */
import { createPersistedStore } from '@/state/persisted.ts';

export const LENGTH_UNITS = ['mm', 'cm', 'in'] as const;
export type LengthUnit = (typeof LENGTH_UNITS)[number];

const MM_PER_UNIT: Readonly<Record<LengthUnit, number>> = { mm: 1, cm: 10, in: 25.4 };

/** Decimals worth showing per unit: 0.1 mm, 0.01 cm and 0.001 in are all finer than a 3D print. */
const DISPLAY_DECIMALS: Readonly<Record<LengthUnit, number>> = { mm: 1, cm: 2, in: 3 };

export function isLengthUnit(value: string): value is LengthUnit {
  return LENGTH_UNITS.some((unit) => unit === value);
}

export const unitStore = createPersistedStore<LengthUnit>(
  'hsw.widgets.unit',
  'mm',
  (raw) => (isLengthUnit(raw) ? raw : null),
  (unit) => unit,
);

export function convertFromMm(mm: number, unit: LengthUnit): number {
  return mm / MM_PER_UNIT[unit];
}

/** Number rounded to the unit's display precision, trailing zeros trimmed ("12.5", "3", "0.197"). */
export function formatNumber(mm: number, unit: LengthUnit): string {
  const rounded = convertFromMm(mm, unit).toFixed(DISPLAY_DECIMALS[unit]);
  const trimmed = rounded.includes('.') ? rounded.replace(/\.?0+$/, '') : rounded;
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

export function formatLength(mm: number, unit: LengthUnit): string {
  return `${formatNumber(mm, unit)} ${unit}`;
}

const SUFFIXES: Readonly<Record<string, LengthUnit>> = {
  mm: 'mm',
  мм: 'mm',
  cm: 'cm',
  см: 'cm',
  in: 'in',
  '"': 'in',
};

const NUMBER_WITH_UNIT = /^([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*(mm|cm|in|мм|см|")?$/i;

/** Plain number, comma or dot as decimal separator; null for anything else (no thousands separators). */
export function parseNumber(text: string): number | null {
  const match = NUMBER_WITH_UNIT.exec(text.trim());
  if (!match || match[2] !== undefined) return null;
  return toFinite(match[1]);
}

/**
 * Millimetres from user text in `unit`. A trailing unit ("12,5 cm", `1"`) overrides `unit`; null when
 * the text is not a single number with an optional known unit.
 */
export function parseLength(text: string, unit: LengthUnit): number | null {
  const match = NUMBER_WITH_UNIT.exec(text.trim());
  if (!match) return null;
  const value = toFinite(match[1]);
  if (value === null) return null;
  const suffix = match[2]?.toLowerCase();
  const used = suffix === undefined ? unit : (SUFFIXES[suffix] ?? unit);
  return value * MM_PER_UNIT[used];
}

function toFinite(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = Number(raw.replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}
