/**
 * Camera recovery from a plane homography. Given the wall->photo homography `H = K [r1 r2 t]` and a square-pixel
 * camera with the principal point at the image centre (the model used by the HSW photo calibration), the
 * focal length follows from the orthogonality of r1, r2 when the wall is tilted. A fronto-parallel photo
 * carries no focal information: callers then pass an EXIF/assumed focal length.
 *
 * Wall frame: x right, y up, z out of the wall towards the room (right handed). Camera frame: OpenCV
 * (x right, y down, z forward).
 */
import {
  cross3,
  dot3,
  mulVec3,
  norm3,
  scaleVec3,
  transpose3,
  type Mat3,
  type Vec2,
  type Vec3,
} from './matrix.ts';
import type { ImageSize } from './photo-map.ts';

export interface CameraPose {
  focalPx: number;
  principal: Vec2;
  /** World (wall frame) -> camera: `x_cam = R x_wall + t`. Row-major. */
  R: Mat3;
  t: Vec3;
  /** Camera centre in the wall frame, mm. */
  position: Vec3;
}

export interface FocalEstimate {
  focalPx: number;
  /** Dimensionless, ~0 for a fronto-parallel wall (focal length undetermined) and growing with tilt. */
  conditioning: number;
}

/**
 * Measured on 4 corner clicks with 0.7 px noise (200 seeds per tilt): at conditioning 0.010 the median focal
 * error is 7%, at 0.021 it is 3.4%, at 0.047 it is 1.9%, at 0.19 it is 0.6%. Below this threshold use
 * `defaultFocalPx` instead.
 */
export const FOCAL_CONDITIONING_MIN = 0.02;

/** 35 mm-equivalent focal length 26 mm: the main camera of most phones. */
export const DEFAULT_FOCAL_35MM = 26;
const FULL_FRAME_DIAGONAL_MM = Math.hypot(36, 24);

/** Focal length in px for an EXIF 35 mm-equivalent value (or the phone default). */
export function defaultFocalPx(image: ImageSize, focal35mm: number = DEFAULT_FOCAL_35MM): number {
  const diagonal = Math.hypot(image.width, image.height);
  return (focal35mm / FULL_FRAME_DIAGONAL_MM) * diagonal;
}

function column(h: Mat3, index: number): Vec3 {
  return [h[index]!, h[3 + index]!, h[6 + index]!];
}

/**
 * Least-squares focal length from `g1.g2 = 0` and `|g1| = |g2|` with `g_i = K^-1 h_i`; both are linear in
 * `1/f^2`. `wallToPx` is the homography from wall mm to photo px. Null when the plane is (nearly)
 * fronto-parallel or the solution is non-physical.
 */
export function estimateFocalPx(wallToPx: Mat3, image: ImageSize): FocalEstimate | null {
  const cx = image.width / 2;
  const cy = image.height / 2;
  const h1 = column(wallToPx, 0);
  const h2 = column(wallToPx, 1);
  const p1: Vec2 = [h1[0] - cx * h1[2], h1[1] - cy * h1[2]];
  const p2: Vec2 = [h2[0] - cx * h2[2], h2[1] - cy * h2[2]];
  // The two constraints are g1.g2 = 0 and |g1|^2 - |g2|^2 = 0. Turning the wall's axes by theta turns the pair
  // (|p1|^2 - |p2|^2, 2 p1.p2) by 2 theta, so the dot-product equation is weighted by 2: that makes both the
  // least-squares fit and the conditioning score independent of the direction of the tilt.
  const a1 = 2 * (p1[0] * p2[0] + p1[1] * p2[1]);
  const b1 = 2 * h1[2] * h2[2];
  const n1 = p1[0] ** 2 + p1[1] ** 2;
  const n2 = p2[0] ** 2 + p2[1] ** 2;
  const a2 = n1 - n2;
  const b2 = h1[2] ** 2 - h2[2] ** 2;
  const denominator = a1 * a1 + a2 * a2;
  if (denominator === 0) return null;
  const w = -(a1 * b1 + a2 * b2) / denominator;
  if (!(w > 0) || !Number.isFinite(w)) return null;
  const conditioning = Math.sqrt(denominator) / (n1 + n2);
  return { focalPx: 1 / Math.sqrt(w), conditioning };
}

/** The focal length estimated from the homography itself, or undefined when the wall is too fronto-parallel to trust it. */
export function reliableFocalPx(wallToPx: Mat3, image: ImageSize): number | undefined {
  const estimate = estimateFocalPx(wallToPx, image);
  return estimate !== null && estimate.conditioning >= FOCAL_CONDITIONING_MIN
    ? estimate.focalPx
    : undefined;
}

/** Decomposes the homography with a known focal length. Throws nothing; returns null for degenerate input. */
export function cameraFromHomography(
  wallToPx: Mat3,
  image: ImageSize,
  focalPx: number,
): CameraPose | null {
  if (!(focalPx > 0)) return null;
  const cx = image.width / 2;
  const cy = image.height / 2;
  const kInv = (v: Vec3): Vec3 => [
    (v[0] - cx * v[2]) / focalPx,
    (v[1] - cy * v[2]) / focalPx,
    v[2],
  ];
  const flip = wallToPx[8] < 0 ? -1 : 1;
  const g1 = scaleVec3(kInv(column(wallToPx, 0)), flip);
  const g2 = scaleVec3(kInv(column(wallToPx, 1)), flip);
  const g3 = scaleVec3(kInv(column(wallToPx, 2)), flip);
  const n1 = norm3(g1);
  const n2 = norm3(g2);
  if (n1 === 0 || n2 === 0) return null;
  const r1 = scaleVec3(g1, 1 / n1);
  // Gram-Schmidt keeps R orthonormal even when noisy clicks make r1, r2 slightly non-orthogonal.
  const proj = dot3(g2, r1);
  const g2o: Vec3 = [g2[0] - proj * r1[0], g2[1] - proj * r1[1], g2[2] - proj * r1[2]];
  const n2o = norm3(g2o);
  if (n2o === 0) return null;
  const r2 = scaleVec3(g2o, 1 / n2o);
  const r3 = cross3(r1, r2);
  const s = (n1 + n2) / 2;
  const t = scaleVec3(g3, 1 / s);
  const R: Mat3 = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]];
  const position = cameraPosition(R, t);
  return { focalPx, principal: [cx, cy], R, t, position };
}

/** Camera centre in the wall frame for `x_cam = R x_wall + t`: `-R^T t`. */
export function cameraPosition(R: Mat3, t: Vec3): Vec3 {
  return scaleVec3(mulVec3(transpose3(R), t), -1);
}

/** Wall->photo homography of the plane z = 0 for a camera. Inverse of `cameraFromHomography` (up to scale). */
export function homographyFromCamera(camera: CameraPose): Mat3 {
  const { focalPx: f, principal, R, t } = camera;
  const [cx, cy] = principal;
  const col = (i: number): Vec3 => column(R, i);
  const toPx = (v: Vec3): Vec3 => [f * v[0] + cx * v[2], f * v[1] + cy * v[2], v[2]];
  const a = toPx(col(0));
  const b = toPx(col(1));
  const c = toPx(t);
  return [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]];
}

/** Projects a wall-frame point (mm, z out of the wall) to photo px; null when it is behind the camera. */
export function projectWallPoint(camera: CameraPose, p: Vec3): Vec2 | null {
  const { R, t, focalPx: f, principal } = camera;
  const x = R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0];
  const y = R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1];
  const z = R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2];
  if (!(z > 1e-9)) return null;
  return [(f * x) / z + principal[0], (f * y) / z + principal[1]];
}

export interface ThreeCamera {
  /** Wall frame = three.js world frame (x right, y up, z towards the room). */
  position: Vec3;
  /** Camera-to-world rotation, row-major: three.js camera looks down -z with +y up. */
  rotation: Mat3;
  fovYDeg: number;
}

/**
 * Parameters of a three.js perspective camera that sees the wall exactly as the photo does (principal point
 * assumed at the image centre), so an R3F canvas can render holders over the photo as a backdrop.
 */
export function threeCameraFromPose(camera: CameraPose, image: ImageSize): ThreeCamera {
  const { R } = camera;
  // camera-to-world = R^T * diag(1, -1, -1)  (OpenCV axes -> three.js axes)
  const rotation: Mat3 = [R[0], -R[3], -R[6], R[1], -R[4], -R[7], R[2], -R[5], -R[8]];
  const fovYDeg = (2 * Math.atan(image.height / (2 * camera.focalPx)) * 180) / Math.PI;
  return { position: camera.position, rotation, fovYDeg };
}
