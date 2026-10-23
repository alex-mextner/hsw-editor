/**
 * Minimal 2D linear algebra for the overlay: 3x3 matrices (row-major tuples, the same layout as the
 * `homography` field of a stored calibration) and a small dense solver. Pure and allocation-light; no
 * dependencies so it runs in the browser, the server and tests alike.
 */

export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
/** Row-major 3x3. */
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

export class DegenerateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DegenerateError';
  }
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const cell = (r: number, c: number): number =>
    a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return [
    cell(0, 0),
    cell(0, 1),
    cell(0, 2),
    cell(1, 0),
    cell(1, 1),
    cell(1, 2),
    cell(2, 0),
    cell(2, 1),
    cell(2, 2),
  ];
}

export function det3(m: Mat3): number {
  const [a, b, c, d, e, f, g, h, i] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/** Largest absolute entry; the yardstick for "is this determinant effectively zero". */
function maxAbs(m: readonly number[]): number {
  let max = 0;
  for (const v of m) max = Math.max(max, Math.abs(v));
  return max;
}

/** Inverse via the adjugate. Throws `DegenerateError` for a (numerically) singular matrix. */
export function inv3(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = det3(m);
  const scale = maxAbs(m);
  if (!Number.isFinite(det) || scale === 0 || Math.abs(det) < 1e-12 * scale ** 3) {
    throw new DegenerateError('matrix is singular');
  }
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    (f * g - d * i) * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    (d * h - e * g) * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ];
}

export function transpose3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function scale3(m: Mat3, s: number): Mat3 {
  return [m[0] * s, m[1] * s, m[2] * s, m[3] * s, m[4] * s, m[5] * s, m[6] * s, m[7] * s, m[8] * s];
}

export function scaleVec3(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function mulVec3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function norm3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Homogeneous 3x3 translation and rotation about the origin. */
export function translation(dx: number, dy: number): Mat3 {
  return [1, 0, dx, 0, 1, dy, 0, 0, 1];
}

export function rotation(deg: number): Mat3 {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/**
 * Solves the dense system `A x = b` by Gaussian elimination with partial pivoting. `A` is square and is
 * NOT modified. Returns null when a pivot is negligible relative to the matrix (singular / rank deficient).
 */
export function solveLinear(
  a: readonly (readonly number[])[],
  b: readonly number[],
): number[] | null {
  const n = b.length;
  const m: number[][] = a.map((row, i) => [...row, b[i]!]);
  let scale = 0;
  for (const row of a) scale = Math.max(scale, maxAbs(row));
  if (scale === 0) return null;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-13 * scale) return null;
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }
    const pivotRow = m[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = m[r]!;
      const factor = row[col]! / pivotRow[col]!;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) row[c] = row[c]! - factor * pivotRow[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    const row = m[r]!;
    let sum = row[n]!;
    for (let c = r + 1; c < n; c++) sum -= row[c]! * x[c]!;
    x[r] = sum / row[r]!;
  }
  return x.every(Number.isFinite) ? x : null;
}
