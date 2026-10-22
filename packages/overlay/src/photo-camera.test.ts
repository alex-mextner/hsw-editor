import { describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD } from '@hsw-editor/core';
import { boardExtent, calibrateFromCorners, calibrateTwoPoint } from './calibration.ts';
import { homographyFromCamera, projectWallPoint } from './camera.ts';
import { inv3, type Vec2 } from './matrix.ts';
import { createPhotoMap } from './photo-map.ts';
import { photoCamera } from './photo-camera.ts';
import {
  IMG_4937,
  IMG_4937_SIZE,
  img4937Camera,
  syntheticCamera,
  wallToPhoto,
} from './test-helpers.ts';

const extent = boardExtent(DEFAULT_BOARD);

describe('photoCamera', () => {
  test('a stored focal length gives back the known camera of the HSW test photo', () => {
    const truth = img4937Camera();
    const map = createPhotoMap(inv3(homographyFromCamera(truth)), IMG_4937_SIZE);
    const cam = photoCamera(map, { storedFocalPx: IMG_4937.focalPx })!;
    expect(cam.focalSource).toBe('stored');
    for (let i = 0; i < 9; i++) expect(Math.abs(cam.pose.R[i]! - truth.R[i]!)).toBeLessThan(1e-9);
    for (let i = 0; i < 3; i++)
      expect(Math.abs(cam.pose.position[i]! - truth.position[i]!)).toBeLessThan(1e-6);
    // an item standing 50 mm off the wall projects where the real camera would put it
    const mine = projectWallPoint(cam.pose, [300, 400, 50])!;
    const real = projectWallPoint(truth, [300, 400, 50])!;
    expect(Math.hypot(mine[0] - real[0], mine[1] - real[1])).toBeLessThan(1e-6);
  });

  test('a two-point (fronto-parallel) calibration uses the assumed focal length and still reproduces the wall plane', () => {
    const image = { width: 1000, height: 800 };
    const cal = calibrateTwoPoint(
      { a: [100, 100], b: [600, 130], realMm: 1000, axis: 'horizontal' },
      image,
      extent,
    );
    const map = createPhotoMap(cal.homography, image);
    const cam = photoCamera(map)!;
    expect(cam.focalSource).toBe('assumed');
    for (const wall of [
      [0, 0],
      [500, 300],
      [900, 700],
    ] as Vec2[]) {
      const viaCamera = projectWallPoint(cam.pose, [wall[0], wall[1], 0])!;
      const viaMap = map.wallToPx(wall)!;
      expect(Math.hypot(viaCamera[0] - viaMap[0], viaCamera[1] - viaMap[1])).toBeLessThan(1e-6);
    }
    expect(cam.three.position[2]).toBeGreaterThan(0);
  });

  test('a clearly tilted 4-corner calibration estimates the focal length and reproduces the plane', () => {
    const image = { width: 1200, height: 1600 };
    const truth = syntheticCamera({
      image,
      focalPx: 1100,
      yawDeg: 25,
      pitchDeg: 18,
      rollDeg: 4,
      distanceMm: 2200,
      lookAt: [600, 500],
    });
    const wallCorners: [Vec2, Vec2, Vec2, Vec2] = [
      [0, 0],
      [1200, 0],
      [1200, 1000],
      [0, 1000],
    ];
    const corners = wallCorners.map((w) => wallToPhoto(truth, w)) as [Vec2, Vec2, Vec2, Vec2];
    const cal = calibrateFromCorners({ cornersPx: corners, widthMm: 1200, heightMm: 1000 }, image);
    const map = createPhotoMap(cal.homography, image);
    const cam = photoCamera(map)!;
    expect(cam.focalSource).toBe('estimated');
    expect(Math.abs(cam.pose.focalPx - 1100)).toBeLessThan(1e-3);
    const probe = projectWallPoint(cam.pose, [700, 400, 120])!;
    const real = projectWallPoint(truth, [700, 400, 120])!;
    expect(Math.hypot(probe[0] - real[0], probe[1] - real[1])).toBeLessThan(1e-3);
  });

  test('EXIF 35 mm focal length changes the assumed focal length', () => {
    const image = { width: 1000, height: 800 };
    const cal = calibrateTwoPoint({ a: [0, 0], b: [500, 0], realMm: 1000 }, image, extent);
    const map = createPhotoMap(cal.homography, image);
    const wide = photoCamera(map, { focal35mm: 13 })!;
    const tele = photoCamera(map, { focal35mm: 52 })!;
    expect(tele.pose.focalPx / wide.pose.focalPx).toBeCloseTo(4, 9);
    // the same wall scale at a longer lens means the camera sits further away
    expect(tele.pose.position[2]).toBeGreaterThan(wide.pose.position[2]);
  });
});
