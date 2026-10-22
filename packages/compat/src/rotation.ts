/**
 * Rotation maths matching how the viewport applies `Pose`: three.js `Euler(rotX, rotY, rotZ, 'XYZ')`, i.e.
 * the rotation matrix is Rx * Ry * Rz (the tool is turned about Z first, then Y, then X), angles in degrees.
 * Everything is a row-major 3x3 matrix; nothing here allocates beyond the returned tuples.
 */
import { normalizeDeg } from '@hsw-editor/core';

export type Vec3 = readonly [number, number, number];
export type Mat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rounds to `decimals` places and turns -0 into 0: float noise out, poses stable and JSON-clean. */
export function roundTo(value: number, decimals = 6): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale + 0;
}

export function rotationX(deg: number): Mat3 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

export function rotationY(deg: number): Mat3 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

export function rotationZ(deg: number): Mat3 {
  const c = Math.cos(deg * RAD);
  const s = Math.sin(deg * RAD);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const [b0, b1, b2, b3, b4, b5, b6, b7, b8] = b;
  return [
    a0 * b0 + a1 * b3 + a2 * b6,
    a0 * b1 + a1 * b4 + a2 * b7,
    a0 * b2 + a1 * b5 + a2 * b8,
    a3 * b0 + a4 * b3 + a5 * b6,
    a3 * b1 + a4 * b4 + a5 * b7,
    a3 * b2 + a4 * b5 + a5 * b8,
    a6 * b0 + a7 * b3 + a8 * b6,
    a6 * b1 + a7 * b4 + a8 * b7,
    a6 * b2 + a7 * b5 + a8 * b8,
  ];
}

export function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export interface Euler {
  rotX: number;
  rotY: number;
  rotZ: number;
}

export function eulerToMatrix(e: Euler): Mat3 {
  return multiply(multiply(rotationX(e.rotX), rotationY(e.rotY)), rotationZ(e.rotZ));
}

/** Inverse of `eulerToMatrix` (three.js `Euler.setFromRotationMatrix`, order XYZ); angles in [0, 360). */
export function matrixToEuler(m: Mat3): Euler {
  const m13 = Math.min(1, Math.max(-1, m[2]));
  const rotY = Math.asin(m13);
  let rotX: number;
  let rotZ: number;
  if (Math.abs(m13) < 0.9999999) {
    rotX = Math.atan2(-m[5], m[8]);
    rotZ = Math.atan2(-m[1], m[0]);
  } else {
    rotX = Math.atan2(m[7], m[4]);
    rotZ = 0;
  }
  const wrap = (rad: number): number => normalizeDeg(roundTo(rad * DEG));
  return { rotX: wrap(rotX), rotY: wrap(rotY), rotZ: wrap(rotZ) };
}

export function transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}
