/**
 * Helpers for flat (plate-like) tools built from 2D outlines in the XY plane: loop transforms, rounded
 * polygons, and thin raised "marks" (graduation ticks, seven-segment numerals) emitted as boxes so that
 * every mark is a closed shell. All dimensions in mm.
 */
import { type V2, DEG } from '../math.ts';
import { type Mesh } from '../mesh.ts';
import { roundedRectRing } from './rings.ts';

export type Loop = readonly V2[];
/** Axis-aligned rectangle [x0, y0, x1, y1]. */
export type Rect = readonly [number, number, number, number];

export const loopMove = (l: Loop, dx: number, dy: number): V2[] =>
  l.map(([x, y]) => [x + dx, y + dy] as V2);

export function loopRotate(l: Loop, deg: number, cx = 0, cy = 0): V2[] {
  const c = Math.cos(deg * DEG);
  const s = Math.sin(deg * DEG);
  return l.map(([x, y]) => {
    const px = x - cx;
    const py = y - cy;
    return [cx + px * c - py * s, cy + px * s + py * c] as V2;
  });
}

export function ellipseLoop(rx: number, ry: number, count = 32, cx = 0, cy = 0): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
  }
  return out;
}

export const rectLoop = (x0: number, y0: number, x1: number, y1: number): V2[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** Rounded rectangle between two corners (r = 0 gives sharp corners with the same point count). */
export function roundedRectLoop(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r: number,
  perCorner = 5,
): V2[] {
  return loopMove(roundedRectRing(x1 - x0, y1 - y0, r, perCorner), (x0 + x1) / 2, (y0 + y1) / 2);
}

/** Polygon whose corners are replaced by smooth quadratic arcs of nominal radius `r`. */
export function roundPolygon(points: Loop, r: number, steps = 5): V2[] {
  const n = points.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[(i + n - 1) % n] as V2;
    const q = points[i] as V2;
    const s = points[(i + 1) % n] as V2;
    const d0x = p[0] - q[0];
    const d0y = p[1] - q[1];
    const d1x = s[0] - q[0];
    const d1y = s[1] - q[1];
    const l0 = Math.hypot(d0x, d0y);
    const l1 = Math.hypot(d1x, d1y);
    const cosA = Math.max(-1, Math.min(1, (d0x * d1x + d0y * d1y) / (l0 * l1 || 1)));
    const angle = Math.acos(cosA);
    if (angle > Math.PI - 1e-3 || angle < 1e-3 || r <= 0) {
      out.push(q);
      continue;
    }
    const t = Math.min(r / Math.tan(angle / 2), l0 * 0.49, l1 * 0.49);
    const a0: V2 = [q[0] + (d0x / l0) * t, q[1] + (d0y / l0) * t];
    const a1: V2 = [q[0] + (d1x / l1) * t, q[1] + (d1y / l1) * t];
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

/** Triangle indices of a box whose 8 corners are laid out bottom (0..3) then top (4..7). */
const BOX_FACES: readonly number[] = [
  0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6,
  1, 6, 5,
];

/** Closed mesh of many axis-aligned boxes sharing the z range [z0, z1] (one disjoint shell per rect). */
export function slabs(rects: readonly Rect[], z0: number, z1: number): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const lo = Math.min(z0, z1);
  const hi = Math.max(z0, z1);
  for (const [ax, ay, bx, by] of rects) {
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    if (x1 - x0 < 1e-6 || y1 - y0 < 1e-6) continue;
    const b = positions.length / 3;
    positions.push(x0, y0, lo, x1, y0, lo, x1, y1, lo, x0, y1, lo);
    positions.push(x0, y0, hi, x1, y0, hi, x1, y1, hi, x0, y1, hi);
    for (const i of BOX_FACES) indices.push(b + i);
  }
  return { positions, indices };
}

export const moveRects = (rs: readonly Rect[], dx: number, dy: number): Rect[] =>
  rs.map(([a, b, c, d]) => [a + dx, b + dy, c + dx, d + dy] as Rect);

const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
};

/** Seven-segment text of height `h`; returns rects from x = 0 (baseline y = 0) and the total width. */
export function digitRects(text: string, h: number): { rects: Rect[]; width: number } {
  const w = h * 0.55;
  const s = Math.max(h * 0.16, 0.12);
  const gap = h * 0.3;
  const rects: Rect[] = [];
  let x = 0;
  for (const ch of text) {
    if (ch === '.') {
      rects.push([x, 0, x + s * 1.1, s * 1.1]);
      x += s * 1.1 + gap;
      continue;
    }
    if (ch === ' ') {
      x += w + gap;
      continue;
    }
    const segs = SEGMENTS[ch];
    if (!segs) continue;
    const seg: Record<string, Rect> = {
      a: [x, h - s, x + w, h],
      b: [x + w - s, h / 2, x + w, h],
      c: [x + w - s, 0, x + w, h / 2],
      d: [x, 0, x + w, s],
      e: [x, 0, x + s, h / 2],
      f: [x, h / 2, x + s, h],
      g: [x, h / 2 - s / 2, x + w, h / 2 + s / 2],
    };
    for (const k of segs) rects.push(seg[k] as Rect);
    x += w + gap;
  }
  return { rects, width: Math.max(0, x - gap) };
}

/**
 * Seven-segment text placed in the XY plane. `q` is the reading direction in quarter turns: 0 reads
 * along +x (glyph up = +y), 1 reads along +y (glyph up = -x), 3 reads along -y (glyph up = +x).
 * (ax, ay) anchor the text: for q = 0 the centre x and baseline y, otherwise the baseline x and the
 * centre y.
 */
export function placeText(str: string, h: number, q: 0 | 1 | 3, ax: number, ay: number): Rect[] {
  const { rects, width } = digitRects(str, h);
  const centred = moveRects(rects, -width / 2, 0);
  if (q === 0) return moveRects(centred, ax, ay);
  const rot: Rect[] =
    q === 1
      ? centred.map(([a, b, c, d]) => [-d, a, -b, c] as Rect)
      : centred.map(([a, b, c, d]) => [b, -c, d, -a] as Rect);
  return moveRects(rot, ax, ay);
}

export interface LinearScale {
  /** Graduations run along this axis. */
  axis: 'x' | 'y';
  /** Position of the zero mark along the axis and the direction values increase in (+1 / -1). */
  origin: number;
  dir: 1 | -1;
  /** Number of mm covered and the spacing of the finest tick. */
  length: number;
  step?: number;
  /** Across coordinate of the edge the ticks start from and the direction they grow in (+1 / -1). */
  edge: number;
  inward: 1 | -1;
  /** Tick lengths for 1 mm / 5 mm / 10 mm marks (scaled by `step / 1`). */
  lens?: readonly [number, number, number];
  thickness?: number;
  /** Numerals every 10 mm (value in cm) with this glyph height; 0 disables. */
  numbers?: number;
  numberQuarter?: 0 | 1 | 3;
  /** Highest value (mm) that still gets a numeral. */
  numbersUpTo?: number;
  /** Skip marks whose along-position lies inside any of these [lo, hi] intervals (covered by a part). */
  skip?: readonly (readonly [number, number])[];
}

/** Graduation ticks and cm numerals as rects in the XY plane (see `slabs`). */
export function linearScale(s: LinearScale): Rect[] {
  const step = s.step ?? 1;
  const lens = s.lens ?? [3, 5, 8];
  const tw = s.thickness ?? 0.14;
  const out: Rect[] = [];
  const skipped = (pos: number): boolean => (s.skip ?? []).some(([lo, hi]) => pos > lo && pos < hi);
  const count = Math.floor(s.length / step + 1e-6);
  for (let i = 0; i <= count; i++) {
    const v = i * step;
    const pos = s.origin + s.dir * v;
    if (skipped(pos)) continue;
    const isTen = Math.abs(v / 10 - Math.round(v / 10)) < 1e-6;
    const isFive = !isTen && Math.abs(v / 5 - Math.round(v / 5)) < 1e-6;
    const len = isTen ? lens[2] : isFive ? lens[1] : lens[0];
    const a0 = pos - tw / 2;
    const a1 = pos + tw / 2;
    const c0 = s.edge;
    const c1 = s.edge + s.inward * len;
    out.push(s.axis === 'y' ? [c0, a0, c1, a1] : [a0, c0, a1, c1]);
  }
  if ((s.numbers ?? 0) > 0) {
    const h = s.numbers as number;
    const q = s.numberQuarter ?? (s.axis === 'x' ? 0 : s.dir === 1 ? 1 : 3);
    const gap = 0.9;
    const top = Math.min(s.length, s.numbersUpTo ?? s.length);
    for (let cm = 1; cm * 10 <= top + 1e-6; cm++) {
      const pos = s.origin + s.dir * cm * 10;
      if (skipped(pos)) continue;
      const across0 = s.edge + s.inward * (lens[2] + gap);
      if (s.axis === 'x') {
        // glyph up = +y: baseline below the ticks when they grow downward from the top edge
        const base = s.inward === -1 ? across0 - h : across0;
        out.push(...placeText(String(cm), h, 0, pos, base));
      } else if (q === 1) {
        const base = s.inward === 1 ? across0 + h : across0;
        out.push(...placeText(String(cm), h, 1, base, pos));
      } else {
        const base = s.inward === 1 ? across0 : across0 - h;
        out.push(...placeText(String(cm), h, 3, base, pos));
      }
    }
  }
  return out;
}

export function circlePoints(cx: number, cy: number, r: number, count = 16): V2[] {
  return ellipseLoop(r, r, count, cx, cy);
}

/** Convex hull (counter-clockwise) of a point cloud: tapers, teardrops, stadiums between circles. */
export function hullLoop(points: readonly V2[]): V2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crossOf = (o: V2, a: V2, b: V2): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: V2[] = [];
  for (const p of pts) {
    while (
      lower.length >= 2 &&
      crossOf(lower[lower.length - 2] as V2, lower[lower.length - 1] as V2, p) <= 1e-9
    )
      lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i] as V2;
    while (
      upper.length >= 2 &&
      crossOf(upper[upper.length - 2] as V2, upper[upper.length - 1] as V2, p) <= 1e-9
    )
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}
