import { describe, expect, test } from 'bun:test';
import { calibrateFromCorners, calibrateTwoPoint } from '@hsw-editor/overlay';
import { boardOutlinePx, percent } from './calibrationWizardView.ts';

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
