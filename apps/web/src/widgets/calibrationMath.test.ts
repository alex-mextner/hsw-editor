import { describe, expect, test } from 'bun:test';
import { CalibrationSchema } from '@hsw-editor/core';
import {
  parseLength,
  pixelDistance,
  toMillimetres,
  twoPointCalibration,
  twoPointScale,
} from './calibrationMath.ts';

describe('twoPointScale', () => {
  test('mm per pixel is the entered distance over the picked pixel distance', () => {
    const result = twoPointScale([100, 100], [400, 500], 250);
    expect(pixelDistance([100, 100], [400, 500])).toBe(500);
    expect(result).toEqual({ ok: true, mmPerPx: 0.5, pixels: 500 });
  });

  test('identical or near-identical points are refused', () => {
    expect(twoPointScale([10, 10], [10, 10], 100)).toEqual({
      ok: false,
      reason: 'points-too-close',
    });
    expect(twoPointScale([10, 10], [10.5, 10.5], 100)).toEqual({
      ok: false,
      reason: 'points-too-close',
    });
  });

  test('a zero, negative or non-finite distance is refused', () => {
    for (const distance of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(twoPointScale([0, 0], [100, 0], distance)).toEqual({
        ok: false,
        reason: 'invalid-distance',
      });
    }
  });
});

describe('parseLength / toMillimetres', () => {
  test('accepts decimal comma and dot, rejects junk and non-positive values', () => {
    expect(parseLength(' 12,5 ')).toBe(12.5);
    expect(parseLength('12.5')).toBe(12.5);
    for (const bad of ['', '  ', '0', '-3', '12mm', 'abc', 'Infinity']) {
      expect(parseLength(bad)).toBeNull();
    }
  });

  test('converts to millimetres', () => {
    expect(toMillimetres(3, 'cm')).toBe(30);
    expect(toMillimetres(2, 'in')).toBeCloseTo(50.8, 10);
    expect(toMillimetres(7, 'mm')).toBe(7);
  });
});

describe('twoPointCalibration', () => {
  test('lays the wall points along x and passes the core schema', () => {
    const calibration = twoPointCalibration([10, 20], [310, 20], 150);
    expect(calibration).toEqual({
      method: 'two-point',
      mmPerPx: 0.5,
      points: [
        { px: [10, 20], wall: [0, 0] },
        { px: [310, 20], wall: [150, 0] },
      ],
    });
    expect(CalibrationSchema.safeParse(calibration).success).toBe(true);
  });

  test('is null for degenerate input', () => {
    expect(twoPointCalibration([5, 5], [5, 5], 100)).toBeNull();
  });
});
