/**
 * Small construction helpers shared by the power / electronics / consumables classes: 2-D outlines,
 * prisms and solids of revolution laid along Z or X, and a closed revolve for rings (tape, tori).
 * Everything returns one closed outward shell, so parts can be merged freely.
 */
import type { V2, V3 } from '../math.ts';
import { type Mesh, ensureOutward, mergeMeshes } from '../mesh.ts';
import type { Material } from '../materials.ts';
import type { Part } from '../model.ts';
import {
  type ExtrudeOptions,
  extrude,
  lathe,
  place,
  at,
  rotX,
  rotY,
  rotZ,
} from '../build/primitives.ts';
import { roundedRectRing } from '../build/rings.ts';

/** Rounded rectangle outline (x, y) centred on (cx, cy). Constant point count for every radius. */
export function rrect(cx: number, cy: number, w: number, h: number, r: number, per = 4): V2[] {
  return roundedRectRing(w, h, r, per).map(([x, y]) => [x + cx, y + cy]);
}

export function circle2(cx: number, cy: number, r: number, n = 32): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Corner of a rounded polygon: x, y and the fillet radius (0 = sharp). */
export type Corner = readonly [number, number, number];

/** Polygon with a quadratic-Bezier fillet at every corner (closed loop). */
export function roundLoop(corners: readonly Corner[], steps = 5): V2[] {
  const n = corners.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = corners[(i + n - 1) % n] as Corner;
    const q = corners[i] as Corner;
    const r = corners[(i + 1) % n] as Corner;
    if (q[2] <= 1e-6) {
      out.push([q[0], q[1]]);
      continue;
    }
    const d0: V2 = [p[0] - q[0], p[1] - q[1]];
    const d1: V2 = [r[0] - q[0], r[1] - q[1]];
    const l0 = Math.hypot(d0[0], d0[1]);
    const l1 = Math.hypot(d1[0], d1[1]);
    const cosA = (d0[0] * d1[0] + d0[1] * d1[1]) / (l0 * l1);
    const angle = Math.acos(Math.max(-1, Math.min(1, cosA)));
    if (angle > Math.PI - 1e-3 || angle < 1e-3) {
      out.push([q[0], q[1]]);
      continue;
    }
    const t = Math.min(q[2] / Math.tan(angle / 2), l0 * 0.48, l1 * 0.48);
    const a0: V2 = [q[0] + (d0[0] / l0) * t, q[1] + (d0[1] / l0) * t];
    const a1: V2 = [q[0] + (d1[0] / l1) * t, q[1] + (d1[1] / l1) * t];
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const w0 = (1 - u) ** 2;
      const w1 = 2 * (1 - u) * u;
      const w2 = u * u;
      out.push([w0 * a0[0] + w1 * q[0] + w2 * a1[0], w0 * a0[1] + w1 * q[1] + w2 * a1[1]]);
    }
  }
  return out;
}

/** Prism of an (x, y) outline between z0 and z1 (alias of `extrude` with the intent spelled out). */
export function slab(outline: readonly V2[], z0: number, z1: number, o: ExtrudeOptions = {}): Mesh {
  return extrude(outline, z0, z1, o);
}

/** Revolve a [r, z] profile about the Z axis through (cx, cy). */
export function revolveZ(profile: readonly V2[], cx: number, cy: number, seg: number): Mesh {
  return place(lathe(profile, seg), rotX(90), at(cx, cy, 0));
}

/** Revolve a [r, x] profile about the X axis through (cy, cz) (y = cy, z = cz). */
export function revolveX(profile: readonly V2[], cy: number, cz: number, seg: number): Mesh {
  return place(lathe(profile, seg), rotZ(-90), at(0, cy, cz));
}

/**
 * Closed revolve about Y of a closed [r, y] loop (r > 0 everywhere): a ring / torus-like solid with an
 * open core, e.g. a tape roll or a hollow collar.
 */
export function revolveLoop(loop: readonly V2[], seg: number): Mesh {
  const m = loop.length;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [r, y] of loop) {
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      positions.push(r * Math.cos(a), y, r * Math.sin(a));
    }
  }
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    for (let k = 0; k < seg; k++) {
      const l = (k + 1) % seg;
      indices.push(i * seg + k, i * seg + l, j * seg + l);
      indices.push(i * seg + k, j * seg + l, j * seg + k);
    }
  }
  return ensureOutward({ positions, indices });
}

/** Extrude an outline given in (z, y) along X between x0 and x1 (side-profile prisms). */
export function slabX(
  outlineZY: readonly V2[],
  x0: number,
  x1: number,
  o: ExtrudeOptions = {},
): Mesh {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  const flipped: V2[] = outlineZY.map(([z, y]) => [-z, y]);
  return place(extrude(flipped, lo, hi, o), rotY(90));
}

/** Points of a helix about Y: `turns` turns of radius r, rising `pitch` per turn from y0. */
export function helix(r: number, y0: number, pitch: number, turns: number, perTurn = 20): V3[] {
  const out: V3[] = [];
  const n = Math.round(turns * perTurn);
  for (let i = 0; i <= n; i++) {
    const a = (i / perTurn) * Math.PI * 2;
    out.push([r * Math.cos(a), y0 + (pitch * i) / perTurn, r * Math.sin(a)]);
  }
  return out;
}

export function part(
  name: string,
  role: string,
  material: Material,
  mesh: Mesh,
  crease?: number,
): Part {
  return crease === undefined
    ? { name, role, material, mesh }
    : { name, role, material, mesh, crease };
}

export const merge = (...meshes: Mesh[]): Mesh => mergeMeshes(meshes);

/** Seven-segment truth table, bits a..g. */
const DIGITS: Record<string, readonly number[]> = {
  '0': [1, 1, 1, 1, 1, 1, 0],
  '1': [0, 1, 1, 0, 0, 0, 0],
  '2': [1, 1, 0, 1, 1, 0, 1],
  '3': [1, 1, 1, 1, 0, 0, 1],
  '4': [0, 1, 1, 0, 0, 1, 1],
  '5': [1, 0, 1, 1, 0, 1, 1],
  '6': [1, 0, 1, 1, 1, 1, 1],
  '7': [1, 1, 1, 0, 0, 0, 0],
  '8': [1, 1, 1, 1, 1, 1, 1],
  '9': [1, 1, 1, 1, 0, 1, 1],
};

/** Skewed rectangle (italic seven-segment bar) centred at (cx, cy). */
function bar(cx: number, cy: number, w: number, h: number, slant: number, origin: number): V2[] {
  const sk = (x: number, y: number): V2 => [x + (y - origin) * slant, y];
  return [
    sk(cx - w / 2, cy - h / 2),
    sk(cx + w / 2, cy - h / 2),
    sk(cx + w / 2, cy + h / 2),
    sk(cx - w / 2, cy + h / 2),
  ];
}

function digitMesh(
  ch: string,
  cx: number,
  cy: number,
  W: number,
  H: number,
  s: number,
  z0: number,
  z1: number,
): Mesh[] {
  const on = DIGITS[ch] ?? [];
  const slant = 0.14;
  const gx = W / 2 - s / 2;
  const hy = H / 4;
  const segs: { x: number; y: number; w: number; h: number }[] = [
    { x: 0, y: H / 2 - s / 2, w: W - s * 1.4, h: s },
    { x: gx, y: hy, w: s, h: H / 2 - s * 1.2 },
    { x: gx, y: -hy, w: s, h: H / 2 - s * 1.2 },
    { x: 0, y: -H / 2 + s / 2, w: W - s * 1.4, h: s },
    { x: -gx, y: -hy, w: s, h: H / 2 - s * 1.2 },
    { x: -gx, y: hy, w: s, h: H / 2 - s * 1.2 },
    { x: 0, y: 0, w: W - s * 1.4, h: s },
  ];
  const out: Mesh[] = [];
  segs.forEach((g, i) => {
    if (on[i]) out.push(extrude(bar(cx + g.x, cy + g.y, g.w, g.h, slant, cy), z0, z1));
  });
  return out;
}

/** Seven-segment text: first digit centred on cx, `step` pitch (digits 0..9). */
export function sevenSegment(
  text: string,
  cx: number,
  cy: number,
  W: number,
  H: number,
  step: number,
  z0: number,
  z1: number,
): Mesh[] {
  return [...text].flatMap((ch, i) => digitMesh(ch, cx + step * i, cy, W, H, W * 0.17, z0, z1));
}

/** Extrude an outline given in (x, z) between y0 and y1 (prisms standing on the XZ plane). */
export function slabY(
  outlineXZ: readonly V2[],
  y0: number,
  y1: number,
  o: ExtrudeOptions = {},
): Mesh {
  return place(extrude(outlineXZ, -Math.max(y0, y1), -Math.min(y0, y1), o), rotX(90));
}
