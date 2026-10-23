import { describe, expect, test } from 'bun:test';
import { createEmptyWall, type Calibration, type Photo, type Wall } from '@hsw-editor/core';
import {
  boardExtent,
  calibrateFromCorners,
  calibrateTwoPoint,
  toCoreCalibration,
} from '@hsw-editor/overlay';
import { fitBox, photoViewState } from './photoView.ts';

const image = { width: 1400, height: 1000 };

function wallWith(calibration: Calibration | undefined): Wall {
  const photo: Photo = {
    id: 'p1',
    file: 'photos/p1.jpg',
    mime: 'image/jpeg',
    width: image.width,
    height: image.height,
    origin: 'upload',
    ...(calibration ? { calibration } : {}),
  };
  return { ...createEmptyWall('w', 'W'), photos: [photo] };
}

const corners = toCoreCalibration(
  calibrateFromCorners(
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
  ),
);

describe('photoViewState', () => {
  test('off without a photo, uncalibrated without a calibration', () => {
    expect(photoViewState(wallWith(corners), null, null).status).toBe('off');
    expect(photoViewState(wallWith(corners), 'missing', null).status).toBe('off');
    expect(photoViewState(wallWith(undefined), 'p1', null).status).toBe('uncalibrated');
  });

  test('the camera looks at the wall point under the photo centre', () => {
    const state = photoViewState(wallWith(corners), 'p1', null);
    if (state.status !== 'ready') throw new Error(state.status);
    const { camera, map } = state.view;
    const [px, py, pz] = camera.three.position;
    const r = camera.three.rotation;
    // three.js cameras look down their own -z: that is minus the third column of the row-major rotation.
    const forward = [-r[2], -r[5], -r[8]] as const;
    const t = -pz / forward[2];
    expect(t).toBeGreaterThan(0);
    const hit = [px + t * forward[0], py + t * forward[1]] as const;
    const centre = map.pxToWall([image.width / 2, image.height / 2]);
    // The camera is recovered from the homography with square pixels and a centred principal point, so
    // its axis meets the wall within a percent of the board width of the photo centre, not exactly.
    expect(Math.abs(hit[0] - (centre?.[0] ?? Number.NaN))).toBeLessThan(10);
    expect(Math.abs(hit[1] - (centre?.[1] ?? Number.NaN))).toBeLessThan(10);
    // The camera is in front of the wall (z > 0), looking at it.
    expect(pz).toBeGreaterThan(0);
  });

  test('a two-point calibration is shown too, with an assumed focal length', () => {
    const wall = wallWith(undefined);
    const calibration = toCoreCalibration(
      calibrateTwoPoint(
        { a: [100, 800], b: [900, 800], realMm: 1000 },
        image,
        boardExtent(wall.board),
      ),
    );
    const state = photoViewState(wallWith(calibration), 'p1', null);
    expect(state.status).toBe('ready');
    if (state.status === 'ready') expect(state.view.camera.focalSource).toBe('assumed');
  });

  test('a draft replaces the stored calibration', () => {
    const draft: Calibration = { ...corners, mmPerPx: 2 };
    const state = photoViewState(wallWith(corners), 'p1', draft);
    expect(state.status === 'ready' && state.view.calibration === draft).toBe(true);
  });

  test('a calibration that is only a scale is still shown', () => {
    const state = photoViewState(wallWith({ method: 'vision', mmPerPx: 1.5 }), 'p1', null);
    expect(state.status).toBe('ready');
  });

  test('a corrupt stored matrix is unusable, not an exception', () => {
    const bad: Calibration = { method: 'manual', homography: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
    expect(photoViewState(wallWith(bad), 'p1', null).status).toBe('unusable');
  });
});

describe('fitBox', () => {
  test('letterboxes a wide photo in a tall container and centres it', () => {
    const box = fitBox({ width: 500, height: 800 }, image);
    expect(box.width).toBe(500);
    expect(box.height).toBeCloseTo(357.142857, 5);
    expect(box.left).toBe(0);
    expect(box.top).toBeCloseTo((800 - box.height) / 2, 8);
  });

  test('pillarboxes a tall photo in a wide container', () => {
    const box = fitBox({ width: 1000, height: 500 }, { width: 600, height: 1000 });
    expect(box.height).toBe(500);
    expect(box.width).toBe(300);
    expect(box.left).toBe(350);
    expect(box.top).toBe(0);
  });
});
