import { describe, expect, test } from 'bun:test';
import {
  cameraFromHomography,
  defaultFocalPx,
  estimateFocalPx,
  FOCAL_CONDITIONING_MIN,
  homographyFromCamera,
  projectWallPoint,
  threeCameraFromPose,
} from './camera.ts';
import { project } from './homography.ts';
import { IMG_4937, IMG_4937_SIZE, img4937Camera, syntheticCamera } from './test-helpers.ts';
import type { Vec2 } from './matrix.ts';

const IMAGE = { width: 1200, height: 1600 };

function camera(yaw: number, pitch: number, focalPx = 1100) {
  return syntheticCamera({
    image: IMAGE,
    focalPx,
    yawDeg: yaw,
    pitchDeg: pitch,
    rollDeg: 2,
    distanceMm: 2200,
    lookAt: [600, 500],
  });
}

describe('camera recovery', () => {
  test('focal length, rotation and translation come back from the homography', () => {
    for (const [yaw, pitch, focal] of [
      [20, 15, 1100],
      [-25, 10, 900],
      [8, -30, 1500],
    ] as const) {
      const truth = camera(yaw, pitch, focal);
      const h = homographyFromCamera(truth);
      const estimate = estimateFocalPx(h, IMAGE);
      expect(estimate).not.toBeNull();
      expect(Math.abs(estimate!.focalPx - focal)).toBeLessThan(1e-6);
      const pose = cameraFromHomography(h, IMAGE, estimate!.focalPx)!;
      for (let i = 0; i < 9; i++) expect(Math.abs(pose.R[i]! - truth.R[i]!)).toBeLessThan(1e-9);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(pose.t[i]! - truth.t[i]!)).toBeLessThan(1e-6);
        expect(Math.abs(pose.position[i]! - truth.position[i]!)).toBeLessThan(1e-6);
      }
    }
  });

  test('a fronto-parallel wall carries no focal information', () => {
    const h = homographyFromCamera(camera(0, 0));
    const estimate = estimateFocalPx(h, IMAGE);
    expect(estimate === null || estimate.conditioning < 1e-6).toBe(true);
  });

  test('recovers the focal length of the real HSW photo from its own plane homography', () => {
    const pose = img4937Camera();
    const estimate = estimateFocalPx(homographyFromCamera(pose), IMG_4937_SIZE)!;
    expect(Math.abs(estimate.focalPx - IMG_4937.focalPx)).toBeLessThan(1e-6);
    // Tilted by only ~7 and ~13 degrees: exact data determines f, but noisy clicks would not (see FOCAL_CONDITIONING_MIN).
    expect(estimate.conditioning).toBeLessThan(FOCAL_CONDITIONING_MIN);
  });

  test('projectWallPoint agrees with the homography on the wall plane and shows depth parallax off it', () => {
    const pose = camera(20, 15);
    const onWall: Vec2 = [300, 400];
    const flat = project(homographyFromCamera(pose), onWall)!;
    const lifted = projectWallPoint(pose, [onWall[0], onWall[1], 0])!;
    expect(Math.hypot(flat[0] - lifted[0], flat[1] - lifted[1])).toBeLessThan(1e-9);
    const raised = projectWallPoint(pose, [onWall[0], onWall[1], 100])!;
    expect(Math.hypot(raised[0] - lifted[0], raised[1] - lifted[1])).toBeGreaterThan(1);
    // Behind the camera is not visible.
    expect(projectWallPoint(pose, [0, 0, 5000])).toBeNull();
  });

  test('three.js camera looks at the wall from the room side', () => {
    const pose = camera(20, 15);
    const three = threeCameraFromPose(pose, IMAGE);
    expect(three.position[2]).toBeGreaterThan(0);
    // The camera looks down its local -z: world direction = -(third column of camera-to-world).
    const look: [number, number, number] = [
      -three.rotation[2],
      -three.rotation[5],
      -three.rotation[8],
    ];
    expect(look[2]).toBeLessThan(0);
    expect(three.fovYDeg).toBeGreaterThan(10);
    expect(three.fovYDeg).toBeLessThan(120);
  });

  test('conditioning grows with tilt', () => {
    const at = (tilt: number): number =>
      estimateFocalPx(homographyFromCamera(camera(tilt, tilt * 0.6)), IMAGE)!.conditioning;
    expect(at(7)).toBeLessThan(at(15));
    expect(at(15)).toBeLessThan(at(30));
    expect(at(30)).toBeGreaterThan(FOCAL_CONDITIONING_MIN);
  });

  test('default focal length follows the 35 mm equivalent', () => {
    expect(defaultFocalPx({ width: 4000, height: 3000 }, 26)).toBeCloseTo(
      (26 / Math.hypot(36, 24)) * 5000,
      9,
    );
  });
});
