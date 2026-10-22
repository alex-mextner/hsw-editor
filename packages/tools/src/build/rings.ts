/**
 * Cross-section rings for `loft`: closed point loops in the (x, z) plane (counter-clockwise seen from
 * +Y... orientation is normalised by the primitives, only the point count has to stay constant between
 * stations of one loft).
 */
import { type V2, DEG } from '../math.ts';

/** Superellipse |x/a|^n + |z/b|^n = 1 (n = 2 ellipse, n ~ 4 soft square, n ~ 8 rounded box). */
export function superellipse(a: number, b: number, n = 2, count = 32): V2[] {
  const out: V2[] = [];
  const e = 2 / n;
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out.push([a * Math.sign(c) * Math.abs(c) ** e, b * Math.sign(s) * Math.abs(s) ** e]);
  }
  return out;
}

export const circleRing = (r: number, count = 32): V2[] => superellipse(r, r, 2, count);

/** Regular polygon with circumradius `r`; `pointy` puts a vertex on +x, otherwise a flat is on +x. */
export function polygonRing(sides: number, r: number, count = sides, pointy = true): V2[] {
  const out: V2[] = [];
  const per = Math.max(1, Math.round(count / sides));
  const rot = pointy ? 0 : Math.PI / sides;
  for (let i = 0; i < sides; i++) {
    const a0 = rot + (i / sides) * Math.PI * 2;
    const a1 = rot + ((i + 1) / sides) * Math.PI * 2;
    for (let k = 0; k < per; k++) {
      const t = k / per;
      out.push([
        r * ((1 - t) * Math.cos(a0) + t * Math.cos(a1)),
        r * ((1 - t) * Math.sin(a0) + t * Math.sin(a1)),
      ]);
    }
  }
  return out;
}

/**
 * Rounded rectangle w (x) by d (z) with corner radius r; `perCorner` arc segments per corner
 * (4 * (perCorner + 1) points, constant for every r including r = 0).
 */
export function roundedRectRing(w: number, d: number, r: number, perCorner = 6): V2[] {
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-6, d / 2 - 1e-6));
  const out: V2[] = [];
  const corners: readonly [number, number, number][] = [
    [w / 2 - rr, d / 2 - rr, 0],
    [-(w / 2 - rr), d / 2 - rr, 90],
    [-(w / 2 - rr), -(d / 2 - rr), 180],
    [w / 2 - rr, -(d / 2 - rr), 270],
  ];
  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= perCorner; k++) {
      const a = (a0 + (90 * k) / perCorner) * DEG;
      out.push([cx + rr * Math.cos(a), cz + rr * Math.sin(a)]);
    }
  }
  return out;
}

/** Circle with `flutes` shallow grooves (grip flutes / knurl hint). `depth` is the groove depth in mm. */
export function flutedRing(r: number, flutes: number, depth: number, count = flutes * 8): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const g = 0.5 - 0.5 * Math.cos(t * flutes);
    const rr = r - depth * g ** 2;
    out.push([rr * Math.cos(t), rr * Math.sin(t)]);
  }
  return out;
}

/** Lobed ring: r(t) = r0 + amp * cos(lobes * t) (Torx, scalloped handles). */
export function lobedRing(r0: number, amp: number, lobes: number, count = lobes * 12): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const rr = r0 + amp * Math.cos(lobes * t);
    out.push([rr * Math.cos(t), rr * Math.sin(t)]);
  }
  return out;
}

/**
 * Cross-shaped ring (Phillips wings): four wings of half-thickness `thick` reaching `reach`, with the
 * inner corners at `thick`. `count` points are spread evenly over the 12-vertex cross (count % 12 === 0).
 */
export function crossRing(reach: number, thick: number, count = 12): V2[] {
  const base: V2[] = [];
  for (let k = 0; k < 4; k++) {
    const a = k * 90 * DEG;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const rot = (x: number, y: number): V2 => [x * ca - y * sa, x * sa + y * ca];
    // counter-clockwise: wing tip right corner, tip left corner, inner corner towards the next wing
    base.push(rot(reach, -thick), rot(reach, thick), rot(thick, thick));
  }
  if (count === base.length) return base;
  // resample evenly along the perimeter to a different count
  return resampleRing(base, count);
}

/** Resample a closed ring to `count` points evenly spaced along its perimeter. */
export function resampleRing(ring: readonly V2[], count: number): V2[] {
  const n = ring.length;
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) {
    const p = ring[i] as V2;
    const q = ring[(i + 1) % n] as V2;
    cum.push((cum[i] ?? 0) + Math.hypot(q[0] - p[0], q[1] - p[1]));
  }
  const total = cum[n] ?? 1;
  const out: V2[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / count) * total;
    while (seg < n - 1 && (cum[seg + 1] ?? 0) < d) seg++;
    const p = ring[seg] as V2;
    const q = ring[(seg + 1) % n] as V2;
    const span = (cum[seg + 1] ?? 0) - (cum[seg] ?? 0);
    const t = span < 1e-12 ? 0 : (d - (cum[seg] ?? 0)) / span;
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

/** Blend two equal-length rings (morph between e.g. a cross and a circle along a bit tip). */
export function blendRings(a: readonly V2[], b: readonly V2[], t: number): V2[] {
  return a.map((p, i) => {
    const q = b[i] as V2;
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  });
}

export function scaleRing(ring: readonly V2[], sx: number, sz = sx): V2[] {
  return ring.map(([x, z]) => [x * sx, z * sz]);
}

export function offsetRing(ring: readonly V2[], dx: number, dz: number): V2[] {
  return ring.map(([x, z]) => [x + dx, z + dz]);
}
