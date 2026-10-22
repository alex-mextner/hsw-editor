/**
 * Fixtures for the overlay tests: a seeded RNG, synthetic cameras looking at the wall plane, and the real
 * calibration of the HSW test photo (IMG_4937, `refit/photo_calibration.json` of the HSW project).
 */
import { project } from './homography.ts';
import { cameraPosition, homographyFromCamera, type CameraPose } from './camera.ts';
import { inv3, mul3, mulVec3, rotation, type Mat3, type Vec2, type Vec3 } from './matrix.ts';
import type { ImageSize } from './photo-map.ts';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

function rotX(deg: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}
function rotY(deg: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}
export interface SyntheticCameraSpec {
  image: ImageSize;
  focalPx: number;
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
  distanceMm: number;
  /** Wall point (mm) the camera looks at. */
  lookAt: Vec2;
}

/** Camera that faces the wall plane (z = 0, y up, z out) from `distanceMm`, then turned by yaw/pitch/roll. */
export function syntheticCamera(spec: SyntheticCameraSpec): CameraPose {
  const facing: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const turn = mul3(rotation(spec.rollDeg), mul3(rotX(spec.pitchDeg), rotY(spec.yawDeg)));
  const R = mul3(turn, facing);
  const centre = mulVec3(R, [spec.lookAt[0], spec.lookAt[1], 0]);
  const t: Vec3 = [-centre[0], -centre[1], spec.distanceMm - centre[2]];
  return {
    focalPx: spec.focalPx,
    principal: [spec.image.width / 2, spec.image.height / 2],
    R,
    t,
    position: cameraPosition(R, t),
  };
}

/** Photo px of a wall point (z = 0) for a camera. */
export function wallToPhoto(camera: CameraPose, wall: Vec2): Vec2 {
  const px = project(homographyFromCamera(camera), wall);
  if (px === null) throw new Error('point at infinity');
  return px;
}

/** Photo -> wall homography of a camera. */
export function photoToWallMatrix(camera: CameraPose): Mat3 {
  return inv3(homographyFromCamera(camera));
}

// ---- IMG_4937 --------------------------------------------------------------------------------------

export const IMG_4937_SIZE: ImageSize = { width: 1152, height: 1536 };
export const IMG_4937 = {
  focalPx: 720.8221227647551,
  /** Object frame of the HSW calibration: x right, y DOWN, z away from the camera. */
  R: [
    [0.9967684714627654, -0.029408076596134855, -0.07475145034511428],
    [0.01940724771247089, 0.9911720630767402, -0.13115372702453143],
    [0.07794852810675142, 0.12927918009917289, 0.9885397920968466],
  ],
  t: [-480.03615566818405, -681.6642457015881, 1157.1824758214211],
} as const;

/** y_obj = WALL_TOP_MM - y_wall: the wall frame of the overlay (y up) laid over the calibration's object frame. */
const WALL_TOP_MM = 2000;

/**
 * The IMG_4937 camera in the overlay's wall frame (x right, y up, z out of the wall): wall (x, y, z) is the
 * calibration's object point (x, 2000 - y, -z).
 */
export function img4937Camera(): CameraPose {
  const r = IMG_4937.R;
  // R_wall = R_obj * diag(1, -1, -1); t_wall = R_obj * (0, 2000, 0) + t_obj
  const R: Mat3 = [
    r[0][0],
    -r[0][1],
    -r[0][2],
    r[1][0],
    -r[1][1],
    -r[1][2],
    r[2][0],
    -r[2][1],
    -r[2][2],
  ];
  const t: Vec3 = [
    r[0][1] * WALL_TOP_MM + IMG_4937.t[0],
    r[1][1] * WALL_TOP_MM + IMG_4937.t[1],
    r[2][1] * WALL_TOP_MM + IMG_4937.t[2],
  ];
  return {
    focalPx: IMG_4937.focalPx,
    principal: [IMG_4937_SIZE.width / 2, IMG_4937_SIZE.height / 2],
    R,
    t,
    position: cameraPosition(R, t),
  };
}
