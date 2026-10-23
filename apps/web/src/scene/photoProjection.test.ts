import { describe, expect, test } from 'bun:test';
import { calibrateFromCorners, createPhotoMap, photoCamera } from '@hsw-editor/overlay';
import { applyRows, exactProjection } from './photoProjection.ts';

const image = { width: 1400, height: 1000 };
const result = calibrateFromCorners(
  {
    cornersPx: [
      [210, 800],
      [1130, 770],
      [1085, 160],
      [250, 190],
    ],
    widthMm: 981,
    heightMm: 755,
  },
  image,
);
const map = createPhotoMap(result.homography, image);
const camera = photoCamera(map);

function projection() {
  if (!camera) throw new Error('no camera');
  const exact = exactProjection(map.wallToPxMatrix, camera.pose, image);
  if (!exact) throw new Error('no projection');
  return exact;
}

describe('exactProjection', () => {
  test('wall points land on exactly the pixels the homography gives', () => {
    const exact = projection();
    for (const wall of [
      [0, 0],
      [981, 0],
      [981, 755],
      [0, 755],
      [490, 377],
      [120, 640],
    ] as const) {
      const clip = applyRows(exact.clip, [wall[0] / 1000, wall[1] / 1000, 0]);
      const px = map.wallToPx([wall[0], wall[1]]);
      expect(clip[3]).toBeGreaterThan(0);
      expect(((clip[0] / clip[3] + 1) / 2) * image.width).toBeCloseTo(px?.[0] ?? Number.NaN, 6);
      expect(((1 - clip[1] / clip[3]) / 2) * image.height).toBeCloseTo(px?.[1] ?? Number.NaN, 6);
    }
  });

  test('a point off the wall towards the room is nearer the camera and still inside the depth range', () => {
    const exact = projection();
    const on = applyRows(exact.clip, [0.4, 0.4, 0]);
    const out = applyRows(exact.clip, [0.4, 0.4, 0.1]);
    expect(out[3]).toBeLessThan(on[3]);
    expect(out[2] / out[3]).toBeLessThan(on[2] / on[3]);
    expect(Math.abs(on[2] / on[3])).toBeLessThan(1);
  });
});
