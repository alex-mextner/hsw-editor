import { describe, expect, test } from 'bun:test';
import { Raycaster, Vector2 } from 'three';
import { calibrateFromCorners, createPhotoMap, photoCamera } from '@hsw-editor/overlay';
import { buildPhotoCamera } from './photoCamera3.ts';

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

describe('buildPhotoCamera', () => {
  test('a pointer ray through a photo pixel meets the wall plane at the calibrated wall point', () => {
    const photo = photoCamera(map);
    if (!photo) throw new Error('no camera');
    const camera = buildPhotoCamera(photo, map.wallToPxMatrix, image);
    const raycaster = new Raycaster();
    for (const px of [
      [700, 500],
      [300, 700],
      [1000, 250],
    ] as const) {
      raycaster.setFromCamera(
        new Vector2((px[0] / image.width) * 2 - 1, 1 - (px[1] / image.height) * 2),
        camera,
      );
      const { origin, direction } = raycaster.ray;
      const t = -origin.z / direction.z;
      expect(t).toBeGreaterThan(0);
      const wall = map.pxToWall([px[0], px[1]]);
      expect((origin.x + t * direction.x) * 1000).toBeCloseTo(wall?.[0] ?? Number.NaN, 3);
      expect((origin.y + t * direction.y) * 1000).toBeCloseTo(wall?.[1] ?? Number.NaN, 3);
    }
  });
});
