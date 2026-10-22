/**
 * Small vector / affine helpers. Everything is in millimetres, right-handed, tool frame:
 * +Y runs from the butt of the tool towards its working end, +Z points at the viewer when the tool lies
 * face-up (the same axes as the HSW wall frame: x right, y up, z out of the wall).
 */
export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

export const DEG = Math.PI / 180;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l];
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerp3 = (a: V3, b: V3, t: number): V3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Row-major 3x4 affine matrix: [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz]. */
export type Affine = readonly [
  number,
  number,
  number,
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

export const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function applyAffine(m: Affine, p: V3): V3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/** `a` applied after `b` (a ∘ b). */
export function compose(a: Affine, b: Affine): Affine {
  const o = new Array<number>(12).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 4 + c] =
        (a[r * 4] ?? 0) * (b[c] ?? 0) +
        (a[r * 4 + 1] ?? 0) * (b[4 + c] ?? 0) +
        (a[r * 4 + 2] ?? 0) * (b[8 + c] ?? 0);
    }
    o[r * 4 + 3] =
      (a[r * 4] ?? 0) * (b[3] ?? 0) +
      (a[r * 4 + 1] ?? 0) * (b[7] ?? 0) +
      (a[r * 4 + 2] ?? 0) * (b[11] ?? 0) +
      (a[r * 4 + 3] ?? 0);
  }
  return o as unknown as Affine;
}

export const translation = (x: number, y: number, z: number): Affine => [
  1,
  0,
  0,
  x,
  0,
  1,
  0,
  y,
  0,
  0,
  1,
  z,
];
export const scaling = (x: number, y = x, z = x): Affine => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
export function rotationX(deg: number): Affine {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}
export function rotationY(deg: number): Affine {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}
export function rotationZ(deg: number): Affine {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}
/** Rotation about an arbitrary axis through the origin (Rodrigues). */
export function rotationAxis(axis: V3, deg: number): Affine {
  const [x, y, z] = norm(axis);
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    0,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    0,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
    0,
  ];
}
/** Rotation that maps unit vector `from` onto unit vector `to`. */
export function rotationBetween(from: V3, to: V3): Affine {
  const a = norm(from);
  const b = norm(to);
  const d = dot(a, b);
  if (d > 1 - 1e-12) return IDENTITY;
  if (d < -1 + 1e-12) {
    const perp: V3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return rotationAxis(norm(cross(a, perp)), 180);
  }
  return rotationAxis(cross(a, b), Math.acos(d) / DEG);
}

export function determinant(m: Affine): number {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

/** Rotation matrix part only, as a 3x3 inverse-transpose is not needed for rigid + uniform scale. */
export function transformDirection(m: Affine, d: V3): V3 {
  return [
    m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
    m[4] * d[0] + m[5] * d[1] + m[6] * d[2],
    m[8] * d[0] + m[9] * d[1] + m[10] * d[2],
  ];
}

export interface Bounds {
  min: V3;
  max: V3;
}

export function sizeOf(b: Bounds): V3 {
  return sub(b.max, b.min);
}

/** Polygon helpers (2-D). */
export function polygonArea(poly: readonly V2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as V2;
    const q = poly[(i + 1) % poly.length] as V2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Sample a closed Catmull-Rom-ish smooth curve through `pts` (open if `closed` is false). */
export function smoothCurve(pts: readonly V2[], perSegment: number, closed = false): V2[] {
  const out: V2[] = [];
  const n = pts.length;
  const get = (i: number): V2 => {
    if (closed) return pts[((i % n) + n) % n] as V2;
    return pts[clamp(i, 0, n - 1)] as V2;
  };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let k = 0; k < perSegment; k++) {
      const t = k / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([
        0.5 *
          (2 * p1[0] +
            (-p0[0] + p2[0]) * t +
            (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
            (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 *
          (2 * p1[1] +
            (-p0[1] + p2[1]) * t +
            (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
            (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ]);
    }
  }
  if (!closed) out.push(pts[n - 1] as V2);
  return out;
}
