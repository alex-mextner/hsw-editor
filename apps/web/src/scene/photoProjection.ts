/**
 * The photo camera's projection built straight from the calibration homography. The wall plane (z = 0) then lands on
 * exactly the pixels `H` says, instead of wherever the recovered pinhole camera (square pixels, centred principal
 * point, orthonormal rotation) puts it; only the depth direction comes from the recovered pose.
 */
import type { CameraPose, Mat3 } from '@hsw-editor/overlay';

export type Row4 = readonly [number, number, number, number];
export type Mat4Rows = readonly [Row4, Row4, Row4, Row4];

export interface ExactProjection {
  /** Row-major 4x4: wall-frame point in metres (x right, y up, z out of the wall) -> clip space. */
  readonly clip: Mat4Rows;
  /** The projective centre of that camera (where its rays meet), wall frame, metres. */
  readonly centre: readonly [number, number, number];
}

const NEAR_FRACTION = 0.02;
const FAR_FACTOR = 60;

/**
 * `wallToPx` is the 3x3 wall mm -> photo px matrix. Clip x/y follow the usual convention (px 0..W -> ndc -1..1,
 * y flipped); clip w is the depth along the photo's viewing axis, z maps it into the depth range.
 */
export function exactProjection(
  wallToPx: Mat3,
  pose: Pick<CameraPose, 'R' | 'focalPx' | 'principal'>,
  image: { readonly width: number; readonly height: number },
): ExactProjection | null {
  const { R, focalPx: f, principal } = pose;
  const [cx, cy] = principal;
  const col = (c: number): [number, number, number] => [
    wallToPx[c]!,
    wallToPx[3 + c]!,
    wallToPx[6 + c]!,
  ];
  const h1 = col(0);
  const h2 = col(1);
  const h3 = col(2);
  // lambda = |K^-1 h1|, signed so that K^-1 h1 points along the recovered r1.
  const k1: [number, number, number] = [(h1[0] - cx * h1[2]) / f, (h1[1] - cy * h1[2]) / f, h1[2]];
  const lambda = Math.hypot(...k1);
  if (!(lambda > 0)) return null;
  const sign = k1[0] * R[0] + k1[1] * R[3] + k1[2] * R[6] < 0 ? -1 : 1;
  // Depth direction: lambda * K * r3, so that (X, Y, Z) maps like K [r1 r2 r3 t] up to the shared factor.
  const r3: [number, number, number] = [R[2], R[5], R[8]];
  const h4: [number, number, number] = [
    sign * lambda * (f * r3[0] + cx * r3[2]),
    sign * lambda * (f * r3[1] + cy * r3[2]),
    sign * lambda * r3[2],
  ];
  // 3x4 pinhole rows for millimetre wall coordinates (columns X, Y, Z, 1), turned to metres in.
  const metres = (a: number, b: number, c: number, d: number): Row4 => [
    a * 1000,
    b * 1000,
    c * 1000,
    d,
  ];
  const rows: [Row4, Row4, Row4] = [
    metres(h1[0], h2[0], h4[0], h3[0]),
    metres(h1[1], h2[1], h4[1], h3[1]),
    metres(h1[2], h2[2], h4[2], h3[2]),
  ];
  // Depth at the wall origin decides the sign and the near/far planes.
  const depthAtOrigin = rows[2][3];
  if (depthAtOrigin === 0) return null;
  const flip = depthAtOrigin < 0 ? -1 : 1;
  const sgn = (row: Row4): Row4 => [row[0] * flip, row[1] * flip, row[2] * flip, row[3] * flip];
  const a = sgn(rows[0]);
  const b = sgn(rows[1]);
  const d = sgn(rows[2]);
  const d0 = Math.abs(depthAtOrigin);
  const near = d0 * NEAR_FRACTION;
  const far = d0 * FAR_FACTOR;
  const mix = (x: Row4, kx: number, y: Row4, ky: number): Row4 => [
    kx * x[0] + ky * y[0],
    kx * x[1] + ky * y[1],
    kx * x[2] + ky * y[2],
    kx * x[3] + ky * y[3],
  ];
  // ndc_x = 2u/W - 1, ndc_y = 1 - 2v/H, ndc_z = (f+n)/(f-n) - 2fn/((f-n) depth)
  const clipX = mix(a, 2 / image.width, d, -1);
  const clipY = mix(b, -2 / image.height, d, 1);
  const k = (far + near) / (far - near);
  const clipZ: Row4 = [k * d[0], k * d[1], k * d[2], k * d[3] - (2 * far * near) / (far - near)];
  const centre = projectiveCentre(rows);
  if (centre === null) return null;
  return { clip: [clipX, clipY, clipZ, d], centre };
}

/** Apply a row-major 4x4 to a point (w = 1). */
export function applyRows(rows: Mat4Rows, point: readonly [number, number, number]): Row4 {
  const [x, y, z] = point;
  const at = (r: Row4): number => r[0] * x + r[1] * y + r[2] * z + r[3];
  return [at(rows[0]), at(rows[1]), at(rows[2]), at(rows[3])];
}

/** Solves P [C; 1] = 0 for the 3x4 `rows`: C = -M^-1 t with M the first three columns. */
function projectiveCentre(rows: readonly [Row4, Row4, Row4]): [number, number, number] | null {
  const [[a, b, c, tx], [d, e, f, ty], [g, h, i, tz]] = rows;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-18) return null;
  const inv = [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ] as const;
  const t = [tx, ty, tz] as const;
  const at = (row: readonly [number, number, number]): number =>
    -(row[0] * t[0] + row[1] * t[1] + row[2] * t[2]) / det;
  return [at(inv[0]), at(inv[1]), at(inv[2])];
}
