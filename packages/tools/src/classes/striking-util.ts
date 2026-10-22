/**
 * Shared helpers of the striking-family generators: smooth multi-channel station profiles, polar ring
 * shapes (rounded boxes / octagons), 2-D outline helpers (corner rounding, toothed edges) and the
 * head-frame transform that lays a Y-axis loft along X (hammer heads, bow frames).
 */
import { type Affine, type V2, lerp, smoothCurve } from '../math.ts';
import { type Station, loft } from '../build/primitives.ts';
import { type Mesh } from '../mesh.ts';
import { polarRing, polygonPolar } from '../build/profile.ts';
import { offsetRing, scaleRing } from '../build/rings.ts';

/** Maps a loft frame (x, y, z) to the head frame: y becomes world X, z becomes world Y, x becomes Z. */
export const HEAD_FRAME: Affine = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0];

const OCTAGON = polygonPolar(8, 1, 0);

/** Radius of the unit superellipse |x|^n + |z|^n = 1 at angle t. */
export function superRadius(n: number, t: number): number {
  return (Math.abs(Math.cos(t)) ** n + Math.abs(Math.sin(t)) ** n) ** (-1 / n);
}

/** Polar shape that morphs from a rounded box (`n`, 2 = circle) towards a regular octagon (`oct` 0..1). */
export function shapePolar(n: number, oct: number): (t: number) => number {
  return (t) => lerp(superRadius(n, t), OCTAGON(t), oct);
}

export interface Keyed {
  /** Position along the loft axis. */
  y: number;
  /** Half extent in ring x / ring z. */
  a: number;
  b: number;
  /** Superellipse exponent (2 circle .. 8 box) and octagon blend 0..1. */
  n?: number;
  oct?: number;
  /** Centre offset in ring x / ring z. */
  cx?: number;
  cz?: number;
  /** Rib / flute depth as a fraction of the radius (needs `ribCount`). */
  rib?: number;
}

/** Smooth (Catmull-Rom) stations through keyed cross sections; every channel is interpolated. */
export function keyedStations(
  keys: readonly Keyed[],
  count: number,
  perSegment = 4,
  ribCount = 0,
): Station[] {
  // Channels are smoothed against the key INDEX; y is then interpolated linearly inside each segment, so
  // stations never run backwards however unevenly the keys are spaced.
  const channel = (pick: (k: Keyed) => number): V2[] =>
    smoothCurve(
      keys.map((k, i) => [i, pick(k)] as const),
      perSegment,
    );
  const a = channel((k) => k.a);
  const ys: V2[] = a.map(([u]) => {
    const i = Math.min(keys.length - 2, Math.floor(u));
    const k0 = keys[i] as Keyed;
    const k1 = keys[i + 1] as Keyed;
    return [lerp(k0.y, k1.y, u - i), 0] as const;
  });
  const b = channel((k) => k.b);
  const n = channel((k) => k.n ?? 2);
  const oct = channel((k) => k.oct ?? 0);
  const cx = channel((k) => k.cx ?? 0);
  const cz = channel((k) => k.cz ?? 0);
  const rib = channel((k) => k.rib ?? 0);
  return ys.map(([y], i) => {
    const at = (c: readonly V2[]): number => (c[i] as V2)[1];
    const base = shapePolar(Math.max(2, at(n)), Math.min(1, Math.max(0, at(oct))));
    const depth = Math.min(0.4, Math.max(0, at(rib)));
    const shape =
      ribCount > 0 && depth > 0
        ? (t: number): number => base(t) * (1 - depth * (0.5 + 0.5 * Math.cos(ribCount * t)))
        : base;
    const ring = offsetRing(
      scaleRing(polarRing(shape, count), Math.max(at(a), 0.01), Math.max(at(b), 0.01)),
      at(cx),
      at(cz),
    );
    return { y, ring };
  });
}

/** Closed polygon with every corner replaced by a quadratic-Bezier fillet of (at most) radius `r`. */
export function roundCorners(
  points: readonly V2[],
  r: number | readonly number[],
  steps = 5,
): V2[] {
  const n = points.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[(i + n - 1) % n] as V2;
    const q = points[i] as V2;
    const s = points[(i + 1) % n] as V2;
    const rad = typeof r === 'number' ? r : (r[i] ?? 0);
    const l0 = Math.hypot(p[0] - q[0], p[1] - q[1]);
    const l1 = Math.hypot(s[0] - q[0], s[1] - q[1]);
    if (rad <= 1e-6 || l0 < 1e-9 || l1 < 1e-9) {
      out.push(q);
      continue;
    }
    const t = Math.min(rad, l0 * 0.5, l1 * 0.5);
    const a0: V2 = [q[0] + ((p[0] - q[0]) / l0) * t, q[1] + ((p[1] - q[1]) / l0) * t];
    const a1: V2 = [q[0] + ((s[0] - q[0]) / l1) * t, q[1] + ((s[1] - q[1]) / l1) * t];
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      out.push([
        (1 - u) ** 2 * a0[0] + 2 * (1 - u) * u * q[0] + u * u * a1[0],
        (1 - u) ** 2 * a0[1] + 2 * (1 - u) * u * q[1] + u * u * a1[1],
      ]);
    }
  }
  return out.filter((q, i) => {
    const prev = out[(i + out.length - 1) % out.length] as V2;
    return Math.hypot(q[0] - prev[0], q[1] - prev[1]) > 1e-6;
  });
}

/** Stadium (slot) outline centred at (cx, cy), width w (x) by height h (y). */
export function stadium(cx: number, cy: number, w: number, h: number, perCorner = 6): V2[] {
  const r = Math.min(w, h) / 2;
  const hw = w / 2;
  const hh = h / 2;
  return roundCorners(
    [
      [cx - hw, cy - hh],
      [cx + hw, cy - hh],
      [cx + hw, cy + hh],
      [cx - hw, cy + hh],
    ],
    r,
    perCorner,
  );
}

/**
 * Sawtooth edge from (y0) to (y1) along a straight line x = xEdge with teeth pointing in `dir` (+1 / -1
 * in x). `rake` shifts the tooth tip along y as a fraction of the pitch (0 = symmetric 60 deg, 0.5 =
 * 90 deg rip tooth). Returns the points in order of increasing y.
 */
export function toothEdge(
  xEdge: number,
  y0: number,
  y1: number,
  pitch: number,
  depth: number,
  dir: 1 | -1,
  rake: number,
): V2[] {
  const count = Math.max(1, Math.round((y1 - y0) / pitch));
  const step = (y1 - y0) / count;
  const out: V2[] = [[xEdge, y0]];
  for (let i = 0; i < count; i++) {
    const ya = y0 + i * step;
    out.push([xEdge + dir * depth, ya + step * (0.5 + rake * 0.5)]);
    out.push([xEdge, ya + step]);
  }
  return out;
}

/** Faceted loft through keyed sections (linear between keys): hard-edged shafts, bars, blades. */
export function loftFaceted(keys: readonly Keyed[], count: number, ribCount = 0): Mesh {
  return loft(keyedStations(keys, count, 1, ribCount));
}
