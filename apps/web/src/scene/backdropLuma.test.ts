import { describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD } from '@hsw-editor/core';
import {
  boardExtent,
  calibrateTwoPoint,
  photoMapFromCalibration,
  toCoreCalibration,
} from '@hsw-editor/overlay';
import { boardPhotoBox } from './backdropLuma.ts';

const image = { width: 1400, height: 1000 };
const extent = boardExtent(DEFAULT_BOARD);

function mapFor(a: [number, number], b: [number, number], realMm: number) {
  const calibration = toCoreCalibration(calibrateTwoPoint({ a, b, realMm }, image, extent));
  const map = photoMapFromCalibration(calibration, image, extent);
  if (!map) throw new Error('no map');
  return map;
}

describe('boardPhotoBox', () => {
  test('is the photo-pixel box of the board corners', () => {
    const map = mapFor([100, 800], [900, 800], 800);
    const box = boardPhotoBox(DEFAULT_BOARD, map);
    if (!box) throw new Error('no box');
    expect(box.x1 - box.x0).toBeCloseTo(extent.widthMm, 0);
    expect(box.y1 - box.y0).toBeCloseTo(extent.heightMm, 0);
  });

  test('is clamped to the photo when the board runs past its edge', () => {
    const map = mapFor([100, 800], [900, 800], 200);
    const box = boardPhotoBox(DEFAULT_BOARD, map);
    if (!box) throw new Error('no box');
    expect(box.x0).toBeGreaterThanOrEqual(0);
    expect(box.y0).toBeGreaterThanOrEqual(0);
    expect(box.x1).toBeLessThanOrEqual(image.width);
    expect(box.y1).toBeLessThanOrEqual(image.height);
  });

  test('is null when the board is entirely outside the photo', () => {
    const map = mapFor([100, 800], [900, 800], 800);
    const away = { ...map, wallToPx: () => [-5000, -5000] as [number, number] };
    expect(boardPhotoBox(DEFAULT_BOARD, away)).toBeNull();
  });
});
