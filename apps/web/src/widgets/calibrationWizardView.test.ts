import { describe, expect, test } from 'bun:test';
import { calibrateFromCorners, calibrateTwoPoint, scaleErrorBound } from '@hsw-editor/overlay';
import { en } from '../i18n/en.ts';
import { interpolate } from '../i18n/format.ts';
import { boardOutlinePx, clickErrorParams, percent } from './calibrationWizardView.ts';

const image = { width: 1000, height: 800 };
const extent = { widthMm: 500, heightMm: 400 };

describe('boardOutlinePx', () => {
  test('four corner clicks put the board outline exactly on the clicks', () => {
    const clicks: [number, number][] = [
      [200, 650],
      [820, 640],
      [800, 150],
      [210, 120],
    ];
    const result = calibrateFromCorners(
      {
        cornersPx: clicks as [
          [number, number],
          [number, number],
          [number, number],
          [number, number],
        ],
        widthMm: 500,
        heightMm: 400,
      },
      image,
    );
    const outline = boardOutlinePx(result, image, extent);
    expect(outline).not.toBeNull();
    outline?.forEach((corner, index) => {
      expect(corner[0]).toBeCloseTo(clicks[index]![0], 3);
      expect(corner[1]).toBeCloseTo(clicks[index]![1], 3);
    });
  });

  test('a two-point calibration centres a board of the right scale under the photo', () => {
    const result = calibrateTwoPoint({ a: [100, 400], b: [600, 400], realMm: 1000 }, image, extent);
    const outline = boardOutlinePx(result, image, extent);
    // 2 mm per px: a 500 x 400 mm board is 250 x 200 px around the photo centre.
    expect(outline?.[0]?.[0]).toBeCloseTo(375, 6);
    expect(outline?.[2]?.[0]).toBeCloseTo(625, 6);
    expect(outline?.[0]?.[1]).toBeCloseTo(500, 6);
    expect(outline?.[2]?.[1]).toBeCloseTo(300, 6);
  });
});

describe('percent', () => {
  test('formats fractions and an unbounded worst case', () => {
    expect(percent(0.0123)).toBe('1.2%');
    expect(percent(0.5, 0)).toBe('50%');
    expect(percent(Number.POSITIVE_INFINITY)).toBe('∞');
  });
});

describe('clickErrorParams', () => {
  test('the readout states the scale error of a 3 px click error in percent and in mm per metre', () => {
    const m = { a: [100, 700] as [number, number], b: [100, 400] as [number, number], realMm: 480 };
    const params = clickErrorParams(
      { onePx: scaleErrorBound(m, 1), threePx: scaleErrorBound(m, 3) },
      (mm) => mm.toFixed(1),
    );
    // 300 px reference: worst case of 3 px per end = 300 / 294 - 1 = 2.04 % = 20.4 mm per metre.
    expect(params.threeWorst).toBe('2.0%');
    expect(params.threeMm).toBe('20.4');
    const text = interpolate(en['photo.wizard.clickError'], params);
    expect(text).toContain('3 px: about 1.4% (at worst 2.0%, 20.4 mm per metre)');
    expect(text).not.toContain('{');
  });
});
