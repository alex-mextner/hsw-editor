/**
 * Closed-shell primitives. Every function returns ONE watertight, outward-oriented mesh (seam vertices
 * are shared, caps use the ring vertices, no T-junctions). Axis conventions: lathe/loft/tube run along +Y,
 * `extrude` builds a prism in the XY plane along Z.
 */
import earcut from 'earcut';
import {
  type Affine,
  type V2,
  type V3,
  add,
  cross,
  dot,
  norm,
  polygonArea,
  rotationX,
  rotationY,
  rotationZ,
  scale,
  scaling,
  sub,
  translation,
  compose,
  IDENTITY,
  DEG,
} from '../math.ts';
import { type Mesh, ensureOutward, mergeMeshes, transformMesh } from '../mesh.ts';
import { circleRing, roundedRectRing } from './rings.ts';

export interface Station {
  y: number;
  /** Ring in the (x, z) plane; same point count at every station of one loft. */
  ring: readonly V2[];
}

export interface LoftOptions {
  /** Close the first / last station with a cap (fan around the ring centroid). Default both. */
  caps?: 'both' | 'start' | 'end' | 'none';
  /** Connect last station to first (torus-like). Implies no caps. */
  closed?: boolean;
}

function ringIsPoint(ring: readonly V2[]): boolean {
  const first = ring[0];
  if (!first) return true;
  return ring.every((p) => Math.abs(p[0] - first[0]) < 1e-7 && Math.abs(p[1] - first[1]) < 1e-7);
}

/**
 * Loft a ring through stations along Y. A station whose ring collapses to a point becomes a single pole
 * vertex (dome, cone tip) so no degenerate triangles appear.
 */
export function loft(stations: readonly Station[], options: LoftOptions = {}): Mesh {
  if (stations.length < 2) throw new Error('loft needs at least two stations');
  const n = (stations[0] as Station).ring.length;
  const positions: number[] = [];
  const indices: number[] = [];
  const rows: { first: number; pole: boolean }[] = [];
  for (const st of stations) {
    if (st.ring.length !== n) throw new Error('loft: every station needs the same ring size');
    const pole = ringIsPoint(st.ring);
    const first = positions.length / 3;
    if (pole) {
      const p = st.ring[0] as V2;
      positions.push(p[0], st.y, p[1]);
    } else {
      for (const p of st.ring) positions.push(p[0], st.y, p[1]);
    }
    rows.push({ first, pole });
  }
  const ringCount = options.closed ? rows.length : rows.length - 1;
  for (let s = 0; s < ringCount; s++) {
    const a = rows[s] as { first: number; pole: boolean };
    const b = rows[(s + 1) % rows.length] as { first: number; pole: boolean };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (a.pole && b.pole) continue;
      if (a.pole) indices.push(a.first, b.first + j, b.first + i);
      else if (b.pole) indices.push(a.first + i, a.first + j, b.first);
      else {
        indices.push(a.first + i, a.first + j, b.first + j);
        indices.push(a.first + i, b.first + j, b.first + i);
      }
    }
  }
  const caps = options.closed ? 'none' : (options.caps ?? 'both');
  const addCap = (
    row: { first: number; pole: boolean },
    y: number,
    ring: readonly V2[],
    up: boolean,
  ): void => {
    if (row.pole) return;
    let cx = 0;
    let cz = 0;
    for (const p of ring) {
      cx += p[0];
      cz += p[1];
    }
    const c = positions.length / 3;
    positions.push(cx / n, y, cz / n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (up) indices.push(c, row.first + i, row.first + j);
      else indices.push(c, row.first + j, row.first + i);
    }
  };
  if (caps === 'both' || caps === 'start') {
    const st = stations[0] as Station;
    addCap(rows[0] as { first: number; pole: boolean }, st.y, st.ring, false);
  }
  if (caps === 'both' || caps === 'end') {
    const st = stations[stations.length - 1] as Station;
    addCap(rows[rows.length - 1] as { first: number; pole: boolean }, st.y, st.ring, true);
  }
  return ensureOutward({ positions, indices });
}

/**
 * Surface of revolution about Y. `profile` points are [radius, y]; radius 0 at either end gives a pole,
 * otherwise a flat cap is added.
 */
export function lathe(profile: readonly V2[], segments = 32): Mesh {
  const stations: Station[] = profile.map(([r, y]) => ({
    y,
    ring: circleRing(Math.max(0, r), segments),
  }));
  return loft(stations);
}

export interface ExtrudeOptions {
  /** Holes (loops of the cut-outs); orientation is normalised. */
  holes?: readonly (readonly V2[])[];
  /** Chamfer / bevel width in mm applied to both faces (0 = square edges). */
  bevel?: number;
  /** Bevel on the front (z1) face only overrides `bevel` for it. */
  bevelFront?: number;
  bevelBack?: number;
}

/** Offset a loop's edges to their left by `d` (mitered, limited). Outer loops CCW: shrink for d > 0. */
export function insetLoop(loop: readonly V2[], d: number): V2[] {
  const n = loop.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = loop[(i + n - 1) % n] as V2;
    const q = loop[i] as V2;
    const r = loop[(i + 1) % n] as V2;
    const e0x = q[0] - p[0];
    const e0y = q[1] - p[1];
    const e1x = r[0] - q[0];
    const e1y = r[1] - q[1];
    const l0 = Math.hypot(e0x, e0y) || 1;
    const l1 = Math.hypot(e1x, e1y) || 1;
    // left normals
    const n0: V2 = [-e0y / l0, e0x / l0];
    const n1: V2 = [-e1y / l1, e1x / l1];
    let mx = n0[0] + n1[0];
    let my = n0[1] + n1[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      mx = n0[0];
      my = n0[1];
    } else {
      mx /= ml;
      my /= ml;
    }
    const cos = Math.max(0.35, mx * n0[0] + my * n0[1]); // miter limit
    out.push([q[0] + (mx * d) / cos, q[1] + (my * d) / cos]);
  }
  return out;
}

function orient(loop: readonly V2[], ccw: boolean): V2[] {
  const a = polygonArea(loop);
  return a > 0 === ccw ? loop.slice() : loop.slice().reverse();
}

/**
 * Prism of `outer` (minus `holes`) from z0 to z1, optionally bevelled. Caps are triangulated with earcut
 * on exactly the ring vertices, so the shell is watertight.
 */
export function extrude(
  outer: readonly V2[],
  z0: number,
  z1: number,
  options: ExtrudeOptions = {},
): Mesh {
  const lo = Math.min(z0, z1);
  const hi = Math.max(z0, z1);
  const loops = [orient(outer, true), ...(options.holes ?? []).map((h) => orient(h, false))];
  const bb = Math.min(options.bevelBack ?? options.bevel ?? 0, (hi - lo) / 2 - 1e-4);
  const bf = Math.min(options.bevelFront ?? options.bevel ?? 0, (hi - lo) / 2 - 1e-4);
  const layers: { z: number; inset: number }[] = [];
  if (bb > 0) layers.push({ z: lo, inset: bb }, { z: lo + bb, inset: 0 });
  else layers.push({ z: lo, inset: 0 });
  if (bf > 0) layers.push({ z: hi - bf, inset: 0 }, { z: hi, inset: bf });
  else layers.push({ z: hi, inset: 0 });

  const positions: number[] = [];
  const indices: number[] = [];
  const loopStart: number[] = [];
  let total = 0;
  for (const l of loops) {
    loopStart.push(total);
    total += l.length;
  }
  const layerBase: number[] = [];
  for (const layer of layers) {
    layerBase.push(positions.length / 3);
    for (const l of loops) {
      const pts = layer.inset > 0 ? insetLoop(l, layer.inset) : l;
      for (const p of pts) positions.push(p[0], p[1], layer.z);
    }
  }
  for (let k = 0; k < layers.length - 1; k++) {
    const a = layerBase[k] as number;
    const b = layerBase[k + 1] as number;
    loops.forEach((l, li) => {
      const s = loopStart[li] as number;
      for (let i = 0; i < l.length; i++) {
        const j = (i + 1) % l.length;
        indices.push(a + s + i, a + s + j, b + s + j);
        indices.push(a + s + i, b + s + j, b + s + i);
      }
    });
  }
  const flat: number[] = [];
  const holeIdx: number[] = [];
  loops.forEach((l, li) => {
    if (li > 0) holeIdx.push(flat.length / 2);
    for (const p of l) flat.push(p[0], p[1]);
  });
  const tris = earcut(flat, holeIdx);
  const back = layerBase[0] as number;
  const front = layerBase[layers.length - 1] as number;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] as number;
    const b = tris[i + 1] as number;
    const c = tris[i + 2] as number;
    indices.push(front + a, front + b, front + c);
    indices.push(back + a, back + c, back + b);
  }
  return ensureOutward({ positions, indices });
}

export type Radius = number | readonly [number, number];

export interface TubeOptions {
  sides?: number;
  closed?: boolean;
  caps?: boolean;
  /** Initial normal direction for the transported frame (defaults to a vector perpendicular to the path). */
  up?: V3;
}

/** Tube along a polyline; radius is a number, an [rx, rz] ellipse, or a function of path fraction t in [0, 1]. */
export function tube(
  path: readonly V3[],
  radius: Radius | ((t: number) => Radius),
  options: TubeOptions = {},
): Mesh {
  const sides = options.sides ?? 16;
  const n = path.length;
  if (n < 2) throw new Error('tube needs at least two points');
  const radiusAt = (i: number): readonly [number, number] => {
    const r = typeof radius === 'function' ? radius(i / (options.closed ? n : n - 1)) : radius;
    return typeof r === 'number' ? [r, r] : r;
  };
  const tangents: V3[] = [];
  for (let i = 0; i < n; i++) {
    const prev = path[options.closed ? (i + n - 1) % n : Math.max(0, i - 1)] as V3;
    const next = path[options.closed ? (i + 1) % n : Math.min(n - 1, i + 1)] as V3;
    tangents.push(norm(sub(next, prev)));
  }
  const t0 = tangents[0] as V3;
  let normal: V3 = options.up ?? (Math.abs(t0[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
  normal = norm(sub(normal, scale(t0, dot(normal, t0))));
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = tangents[i] as V3;
    normal = norm(sub(normal, scale(t, dot(normal, t))));
    const binormal = norm(cross(t, normal));
    const [rx, rz] = radiusAt(i);
    const p = path[i] as V3;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const q = add(p, add(scale(normal, Math.cos(a) * rx), scale(binormal, Math.sin(a) * rz)));
      positions.push(q[0], q[1], q[2]);
    }
  }
  const segs = options.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = i * sides;
    const b = ((i + 1) % n) * sides;
    for (let s = 0; s < sides; s++) {
      const j = (s + 1) % sides;
      indices.push(a + s, a + j, b + j);
      indices.push(a + s, b + j, b + s);
    }
  }
  if (!options.closed && options.caps !== false) {
    const cap = (i: number, flip: boolean): void => {
      const c = positions.length / 3;
      const p = path[i] as V3;
      positions.push(p[0], p[1], p[2]);
      const base = i * sides;
      for (let s = 0; s < sides; s++) {
        const j = (s + 1) % sides;
        if (flip) indices.push(c, base + j, base + s);
        else indices.push(c, base + s, base + j);
      }
    };
    cap(0, false);
    cap(n - 1, true);
  }
  return ensureOutward({ positions, indices });
}

/** Polyline with rounded corners (each interior vertex replaced by an arc of `radius`). */
export function roundedPath(points: readonly V3[], radius: number, arcSteps = 8): V3[] {
  const out: V3[] = [points[0] as V3];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i - 1] as V3;
    const q = points[i] as V3;
    const r = points[i + 1] as V3;
    const d0 = norm(sub(p, q));
    const d1 = norm(sub(r, q));
    const angle = Math.acos(Math.max(-1, Math.min(1, dot(d0, d1))));
    if (angle > Math.PI - 1e-4 || angle < 1e-4) {
      out.push(q);
      continue;
    }
    const l0 = Math.hypot(...sub(p, q));
    const l1 = Math.hypot(...sub(r, q));
    const t = Math.min(radius / Math.tan(angle / 2), l0 * 0.49, l1 * 0.49);
    const a0 = add(q, scale(d0, t));
    const a1 = add(q, scale(d1, t));
    for (let k = 0; k <= arcSteps; k++) {
      const u = k / arcSteps;
      // quadratic Bezier through the corner gives a smooth fillet
      const m0 = add(scale(a0, (1 - u) ** 2), add(scale(q, 2 * (1 - u) * u), scale(a1, u * u)));
      out.push(m0);
    }
  }
  out.push(points[points.length - 1] as V3);
  return out;
}

/** Axis-aligned box centred on the origin; `r` rounds the edges (r = 0 gives sharp edges). */
export function box(w: number, h: number, d: number, r = 0, edgeSteps = 3): Mesh {
  const rr = Math.min(r, w / 2 - 1e-6, d / 2 - 1e-6, h / 2 - 1e-6);
  if (rr <= 0) {
    const ring = roundedRectRing(w, d, 0, 1);
    return loft([
      { y: -h / 2, ring },
      { y: h / 2, ring },
    ]);
  }
  const stations: Station[] = [];
  const steps = Math.max(1, edgeSteps);
  const make = (inset: number, y: number): Station => ({
    y,
    ring: roundedRectRing(w - 2 * inset, d - 2 * inset, Math.max(rr - inset, 1e-4), 5),
  });
  for (let k = 0; k <= steps; k++) {
    const a = (k / steps) * (Math.PI / 2);
    stations.push(make(rr * (1 - Math.sin(a)), -h / 2 + rr * (1 - Math.cos(a))));
  }
  for (let k = steps; k >= 0; k--) {
    const a = (k / steps) * (Math.PI / 2);
    stations.push(make(rr * (1 - Math.sin(a)), h / 2 - rr * (1 - Math.cos(a))));
  }
  return loft(stations);
}

/** Cylinder along Y centred on the origin. */
export function cylinder(r: number, h: number, segments = 32): Mesh {
  return lathe(
    [
      [r, -h / 2],
      [r, h / 2],
    ],
    segments,
  );
}

export function sphere(r: number, segments = 24): Mesh {
  const prof: V2[] = [];
  const rings = Math.max(4, Math.round(segments / 2));
  for (let i = 0; i <= rings; i++) {
    const a = (i / rings) * Math.PI;
    prof.push([r * Math.sin(a), -r * Math.cos(a)]);
  }
  return lathe(prof, segments);
}

/** Torus in the XZ plane (axis Y): ring radius `big`, tube radius `small`. */
export function torus(big: number, small: number, segments = 32, sides = 12): Mesh {
  const path: V3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    path.push([big * Math.cos(a), 0, big * Math.sin(a)]);
  }
  return tube(path, small, { sides, closed: true, up: [0, 1, 0] });
}

/** Shorthand for chained placement: transforms apply in call order. */
export function place(mesh: Mesh, ...steps: Affine[]): Mesh {
  let m: Affine = IDENTITY;
  for (const s of steps) m = compose(s, m);
  return transformMesh(mesh, m);
}

export const at = (x: number, y: number, z: number): Affine => translation(x, y, z);
export const rotX = rotationX;
export const rotY = rotationY;
export const rotZ = rotationZ;
export const scl = scaling;
export const mirrorX: Affine = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export const mirrorZ: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0];

export { mergeMeshes, DEG };
