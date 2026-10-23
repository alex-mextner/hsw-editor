/**
 * Planar homographies: fitting from point correspondences (normalised DLT, least squares), applying and
 * reporting the reprojection error. A homography `H` maps photo pixels to wall millimetres, so the wall
 * plane becomes metric even when the camera is tilted. Lens distortion is NOT modelled (phone main-camera
 * photos are close enough; the reprojection report shows when they are not).
 */
import {
  DegenerateError,
  inv3,
  mul3,
  scale3,
  solveLinear,
  type Mat3,
  type Vec2,
} from './matrix.ts';

export interface Correspondence {
  /** Photo pixel (x right, y down, origin at the top-left of the oriented image). */
  px: Vec2;
  /** The same point on the wall plane, mm (x right, y up, origin at the board's lower-left corner). */
  wall: Vec2;
}

/** Projects a point; null when it maps to infinity (w ~ 0). Callers that care about the horizon side check the sign of w themselves. */
export function project(h: Mat3, p: Vec2): Vec2 | null {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
  return [(h[0] * p[0] + h[1] * p[1] + h[2]) / w, (h[3] * p[0] + h[4] * p[1] + h[5]) / w];
}

/** Like `project` but throws for a point at infinity: for callers that built the matrix themselves. */
export function projectOrThrow(h: Mat3, p: Vec2): Vec2 {
  const out = project(h, p);
  if (out === null) throw new DegenerateError('point projects to infinity');
  return out;
}

/** Hartley normalisation: centroid to the origin, mean distance to sqrt(2). Keeps the DLT well conditioned. */
function normalisation(points: readonly Vec2[]): Mat3 {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p[0];
    cy += p[1];
  }
  cx /= points.length;
  cy /= points.length;
  let mean = 0;
  for (const p of points) mean += Math.hypot(p[0] - cx, p[1] - cy);
  mean /= points.length;
  if (mean < 1e-12) throw new DegenerateError('points coincide');
  const s = Math.SQRT2 / mean;
  return [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1];
}

/** Applies a normalisation matrix (scale + translation only, see `normalisation`). */
function applyNormalisation(t: Mat3, p: Vec2): Vec2 {
  return [t[0] * p[0] + t[2], t[4] * p[1] + t[5]];
}

/**
 * Minimum 4 correspondences, no three collinear. With more, solves the least-squares problem. The result is
 * normalised so that `h[8] = 1` when possible (only a cosmetic choice: homographies are up to scale).
 * Throws `DegenerateError` for collinear / coincident input.
 */
export function fitHomography(pairs: readonly Correspondence[]): Mat3 {
  if (pairs.length < 4) throw new DegenerateError('a homography needs at least 4 point pairs');
  const tFrom = normalisation(pairs.map((p) => p.px));
  const tTo = normalisation(pairs.map((p) => p.wall));
  // Unknowns h0..h7 with h8 fixed at 1 in the normalised frame: after Hartley normalisation the
  // origin-at-centroid convention keeps h8 away from 0 for any non-degenerate configuration.
  const ata: number[][] = Array.from({ length: 8 }, () => new Array<number>(8).fill(0));
  const atb = new Array<number>(8).fill(0);
  const accumulate = (row: readonly number[], rhs: number): void => {
    for (let i = 0; i < 8; i++) {
      atb[i] = atb[i]! + row[i]! * rhs;
      for (let j = 0; j < 8; j++) ata[i]![j] = ata[i]![j]! + row[i]! * row[j]!;
    }
  };
  for (const pair of pairs) {
    const [x, y] = applyNormalisation(tFrom, pair.px);
    const [u, v] = applyNormalisation(tTo, pair.wall);
    accumulate([x, y, 1, 0, 0, 0, -x * u, -y * u], u);
    accumulate([0, 0, 0, x, y, 1, -x * v, -y * v], v);
  }
  const h = solveLinear(ata, atb);
  if (h === null) throw new DegenerateError('point configuration is degenerate (collinear?)');
  const normalised: Mat3 = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
  const full = mul3(mul3(inv3(tTo), normalised), tFrom);
  const last = full[8];
  const result: Mat3 = Math.abs(last) > 1e-12 ? scale3(full, 1 / last) : full;
  // A valid projective map of a quad has a non-singular matrix; reject numerically collapsed fits.
  inv3(result);
  return result;
}

export interface ReprojectionReport {
  /** Per-point residual measured in the PHOTO (px): where the wall point lands vs where it was clicked. */
  residualsPx: number[];
  /** Per-point residual measured on the WALL (mm): where the clicked pixel lands vs the stated wall point. */
  residualsMm: number[];
  rmsPx: number;
  maxPx: number;
  rmsMm: number;
  maxMm: number;
}

function rms(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((a, v) => a + v * v, 0) / values.length);
}

/** `h` maps photo px to wall mm (`inverse` = its inverse, when the caller already has it). A fit through exactly 4 points has zero residual by construction. */
export function reprojectionReport(
  h: Mat3,
  pairs: readonly Correspondence[],
  inverse: Mat3 = inv3(h),
): ReprojectionReport {
  const residualsPx: number[] = [];
  const residualsMm: number[] = [];
  for (const pair of pairs) {
    const back = project(inverse, pair.wall);
    const forward = project(h, pair.px);
    residualsPx.push(
      back === null ? Infinity : Math.hypot(back[0] - pair.px[0], back[1] - pair.px[1]),
    );
    residualsMm.push(
      forward === null
        ? Infinity
        : Math.hypot(forward[0] - pair.wall[0], forward[1] - pair.wall[1]),
    );
  }
  return {
    residualsPx,
    residualsMm,
    rmsPx: rms(residualsPx),
    maxPx: Math.max(0, ...residualsPx),
    rmsMm: rms(residualsMm),
    maxMm: Math.max(0, ...residualsMm),
  };
}

/** Signed area of a polygon (positive = counter-clockwise in a y-up frame). */
export function signedArea(points: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/**
 * True when the points form a strictly convex polygon in the given order (all turns the same way, no
 * collinear triple). Used to validate the 4 clicked wall corners.
 */
export function isConvexOrdered(points: readonly Vec2[]): boolean {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const c = points[(i + 2) % points.length]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}
