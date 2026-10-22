/** Pure maths of the two-point photo calibration. Photo pixels: u right, v down (image rows). */
import type { Calibration } from '@hsw-editor/core';

export type Point2 = readonly [number, number];

export type LengthUnit = 'mm' | 'cm' | 'in';
export const LENGTH_UNITS: readonly LengthUnit[] = ['mm', 'cm', 'in'];

const MM_PER_UNIT: Readonly<Record<LengthUnit, number>> = { mm: 1, cm: 10, in: 25.4 };

/** Two picks closer than this are the same click, not a measurement. */
export const MIN_SEPARATION_PX = 2;

export function pixelDistance(a: Point2, b: Point2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function toMillimetres(value: number, unit: LengthUnit): number {
  return value * MM_PER_UNIT[unit];
}

/** Accepts `12,5` as well as `12.5`; null for empty, non-numeric, zero or negative input. */
export function parseLength(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export type ScaleResult =
  | { readonly ok: true; readonly mmPerPx: number; readonly pixels: number }
  | { readonly ok: false; readonly reason: 'points-too-close' | 'invalid-distance' };

/** Scale of a fronto-parallel photo from two picked pixels that are `distanceMm` apart on the wall. */
export function twoPointScale(a: Point2, b: Point2, distanceMm: number): ScaleResult {
  if (!Number.isFinite(distanceMm) || distanceMm <= 0)
    return { ok: false, reason: 'invalid-distance' };
  const pixels = pixelDistance(a, b);
  if (!Number.isFinite(pixels) || pixels < MIN_SEPARATION_PX) {
    return { ok: false, reason: 'points-too-close' };
  }
  return { ok: true, mmPerPx: distanceMm / pixels, pixels };
}

/**
 * The calibration stored on the photo. The two wall points are laid out along x from the origin: the
 * pick order defines the direction, the entered distance the length (the wall position of the photo
 * itself is not known from two points).
 */
export function twoPointCalibration(a: Point2, b: Point2, distanceMm: number): Calibration | null {
  const scale = twoPointScale(a, b, distanceMm);
  if (!scale.ok) return null;
  return {
    method: 'two-point',
    mmPerPx: scale.mmPerPx,
    points: [
      { px: [a[0], a[1]], wall: [0, 0] },
      { px: [b[0], b[1]], wall: [distanceMm, 0] },
    ],
  };
}
