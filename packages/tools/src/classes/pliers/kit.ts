/**
 * Shared geometry kit of the pliers family: filleted 2-D outlines, spine paths with swept handle sleeves,
 * rivets, serration strips, D-section nose lofts and the assembler that turns one closed-pose lever
 * (jaw on +x, handle on -x) into the two crossed levers of a pair of pliers in any opening pose.
 * Both levers are the same forging: lever B is lever A turned 180 degrees about the Y axis.
 */
import { type V2, type V3, DEG, lerp, smoothCurve } from '../../math.ts';
import { type Mesh, mergeMeshes, transformMesh } from '../../mesh.ts';
import {
  type Station,
  at,
  extrude,
  lathe,
  loft,
  place,
  rotX,
  rotY,
  rotZ,
  roundedPath,
  tube,
} from '../../build/primitives.ts';
import type { Material } from '../../materials.ts';
import type { Part } from '../../model.ts';

/** Outline vertex with an optional fillet radius: [x, y, r]. */
export type Pt = readonly [number, number, number?];

const hyp = Math.hypot;

/** Round the corners of a closed outline (quadratic fillets); each vertex carries its own radius. */
export function roundedOutline(pts: readonly Pt[], steps = 5): V2[] {
  const n = pts.length;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[(i + n - 1) % n] as Pt;
    const q = pts[i] as Pt;
    const r = pts[(i + 1) % n] as Pt;
    const rad = q[2] ?? 0;
    const e0x = p[0] - q[0];
    const e0y = p[1] - q[1];
    const e1x = r[0] - q[0];
    const e1y = r[1] - q[1];
    const l0 = hyp(e0x, e0y);
    const l1 = hyp(e1x, e1y);
    const cos = (e0x * e1x + e0y * e1y) / (l0 * l1 || 1);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
    if (rad <= 0 || angle > Math.PI - 1e-3 || angle < 1e-3) {
      out.push([q[0], q[1]]);
      continue;
    }
    const t = Math.min(rad / Math.tan(angle / 2), l0 * 0.48, l1 * 0.48);
    const a0: V2 = [q[0] + (e0x / l0) * t, q[1] + (e0y / l0) * t];
    const a1: V2 = [q[0] + (e1x / l1) * t, q[1] + (e1y / l1) * t];
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

/** Arc points around (cx, cy), angles in degrees, `count` + 1 points. */
export function arcPoints(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  count: number,
): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= count; i++) {
    const a = lerp(a0, a1, i / count) * DEG;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Uniformly arc-length sampled smooth path through control points. */
export interface Spine {
  pts: V2[];
  /** Cumulative arc length at each point. */
  s: number[];
  length: number;
}

export function makeSpine(ctrl: readonly V2[], perSegment = 12): Spine {
  const raw = smoothCurve(ctrl, perSegment, false);
  const s: number[] = [0];
  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1] as V2;
    const b = raw[i] as V2;
    s.push((s[i - 1] as number) + hyp(b[0] - a[0], b[1] - a[1]));
  }
  return { pts: raw, s, length: s[s.length - 1] as number };
}

export function spineAt(sp: Spine, s: number): V2 {
  const c = Math.min(sp.length, Math.max(0, s));
  let lo = 0;
  let hi = sp.s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((sp.s[mid] as number) <= c) lo = mid;
    else hi = mid;
  }
  const a = sp.pts[lo] as V2;
  const b = sp.pts[hi] as V2;
  const span = (sp.s[hi] as number) - (sp.s[lo] as number) || 1;
  const u = (c - (sp.s[lo] as number)) / span;
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u)];
}

/**
 * Sample positions along [0, length] that cluster towards both ends (rounded end caps need the density)
 * while keeping the middle regular for grooves.
 */
export function sleeveSamples(length: number, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const u = i / (count - 1);
    out.push(length * (0.72 * u + 0.28 * (0.5 - 0.5 * Math.cos(Math.PI * u))));
  }
  return out;
}

/** Cap factor: 1 in the middle, rounded to ~0 over `r0` / `r1` mm at the ends of [0, length]. */
export function capFactor(s: number, length: number, r0: number, r1: number): number {
  const d0 = s / Math.max(r0, 1e-6);
  const d1 = (length - s) / Math.max(r1, 1e-6);
  const f0 = d0 >= 1 ? 1 : Math.sqrt(Math.max(0, 1 - (1 - d0) ** 2));
  const f1 = d1 >= 1 ? 1 : Math.sqrt(Math.max(0, 1 - (1 - d1) ** 2));
  return Math.max(0.1, Math.min(f0, f1));
}

/**
 * Elliptical sleeve swept along a plan-view spine. `shape(s)` returns [half thickness (z), half width
 * (in the plan plane)] at arc length `s`.
 */
export function sleeveMesh(
  sp: Spine,
  shape: (s: number) => readonly [number, number],
  count: number,
  sides: number,
  from = 0,
  to: number = sp.length,
): Mesh {
  const ss = sleeveSamples(to - from, count).map((v) => v + from);
  const path: V3[] = ss.map((s) => {
    const p = spineAt(sp, s);
    return [p[0], p[1], 0];
  });
  return tube(
    path,
    (t) => {
      const i = Math.min(ss.length - 1, Math.max(0, Math.round(t * (ss.length - 1))));
      return shape(ss[i] as number);
    },
    { sides, up: [0, 0, 1] },
  );
}

/** Plan-view band along a spine segment (constant or varying half width), as a closed outline. */
export function bandOutline(
  sp: Spine,
  from: number,
  to: number,
  halfWidth: number | ((s: number) => number),
  count = 24,
): V2[] {
  const left: V2[] = [];
  const right: V2[] = [];
  for (let i = 0; i < count; i++) {
    const s = lerp(from, to, i / (count - 1));
    const a = spineAt(sp, Math.max(0, s - 0.5));
    const b = spineAt(sp, Math.min(sp.length, s + 0.5));
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const tl = hyp(tx, ty) || 1;
    const nx = -ty / tl;
    const ny = tx / tl;
    const w = typeof halfWidth === 'number' ? halfWidth : halfWidth(s);
    const p = spineAt(sp, s);
    left.push([p[0] + nx * w, p[1] + ny * w]);
    right.push([p[0] - nx * w, p[1] - ny * w]);
  }
  return [...left, ...right.reverse()];
}

/** Rivet / pivot bolt along Z with domed heads, centred at the origin. */
export function rivetMesh(r: number, thickness: number, seg: number): Mesh {
  const h = thickness / 2 + 1.1;
  const prof: V2[] = [
    [0, -h],
    [r * 0.55, -h + 0.28],
    [r * 0.9, -h + 0.7],
    [r, -h + 1.1],
    [r, h - 1.1],
    [r * 0.9, h - 0.7],
    [r * 0.55, h - 0.28],
    [0, h],
  ];
  return place(lathe(prof, seg), rotX(90));
}

/** Saw-tooth strip for jaw faces. Teeth point towards -x for `dir` = -1 (lever A: jaw on +x). */
export function toothStrip(
  baseX: number,
  y0: number,
  y1: number,
  pitch: number,
  depth: number,
  dir: 1 | -1,
): V2[] {
  const n = Math.max(2, Math.round((y1 - y0) / pitch));
  const step = (y1 - y0) / n;
  const out: V2[] = [[baseX - dir * 0.6, y0]];
  out.push([baseX, y0]);
  for (let i = 0; i < n; i++) {
    out.push([baseX + dir * depth, y0 + step * (i + 0.5)]);
    out.push([baseX, y0 + step * (i + 1)]);
  }
  out.push([baseX - dir * 0.6, y1]);
  return out;
}

/** D-section nose (flat face on x = 0) lofted along Y; `w` = width in x, `t` = half thickness in z. */
export interface NoseStation {
  y: number;
  w: number;
  t: number;
}
export function noseLoft(
  st: readonly NoseStation[],
  sideSign: 1 | -1,
  count: number,
  squareness = 2.6,
  shearDeg = 0,
): Mesh {
  const ring = (w: number, t: number): V2[] => {
    const out: V2[] = [];
    const e = 2 / squareness;
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (Math.PI * i) / (count - 1);
      const c = Math.cos(a);
      const s = Math.sin(a);
      out.push([sideSign * w * Math.abs(c) ** e, t * Math.sign(s) * Math.abs(s) ** e]);
    }
    return out;
  };
  const stations: Station[] = st.map((q) => ({ y: q.y, ring: ring(q.w, q.t) }));
  const mesh = loft(stations);
  if (shearDeg === 0) return mesh;
  const k = Math.tan(shearDeg * DEG);
  return transformMesh(mesh, [1, 0, 0, 0, 0, 1, k, 0, 0, 0, 1, 0]);
}

/** Rotate a mesh about the point (px, py) around Z. */
export function swing(mesh: Mesh, px: number, py: number, deg: number): Mesh {
  if (deg === 0) return mesh;
  return place(mesh, at(-px, -py, 0), rotZ(deg), at(px, py, 0));
}

/** One lever in the closed pose (jaw on +x, handle on -x). */
export interface LeverMeshes {
  metal: Mesh[];
  faces: Mesh[];
  edges: Mesh[];
  sleeve: Mesh | null;
  /** Second-component grips on the handle. */
  inserts: Mesh[];
  /** Steel handle bar when there is no sleeve. */
  bare: Mesh | null;
}

export interface CrossingMaterials {
  metal: Material;
  face: Material;
  edge: Material;
  sleeve: Material;
  insert: Material;
  pivot: Material;
}

export interface CrossingOptions {
  pivot: V2;
  /** Total opening angle of the jaws, degrees. */
  openDeg: number;
  lever: LeverMeshes;
  /** Pivot bolt, positioned at the pivot point. */
  rivet: Mesh;
  mats: CrossingMaterials;
  /** Extra shells shared by both levers (spring, latch...), positioned in the closed pose. */
  extra?: Part[];
  /** Separate geometry of lever B (built in the A frame, turned like A); default is A itself. */
  leverB?: LeverMeshes;
}

const merged = (list: readonly Mesh[]): Mesh | null => (list.length ? mergeMeshes(list) : null);

/** Build the two crossed levers plus pivot. Lever A (jaw right, handle left) swings clockwise. */
export function assembleCrossing(o: CrossingOptions): Part[] {
  const [px, py] = o.pivot;
  const half = o.openDeg / 2;
  const parts: Part[] = [];
  const sides = [
    { jaw: 'right', handle: 'left', angle: -half, turn: false },
    { jaw: 'left', handle: 'right', angle: half, turn: true },
  ] as const;
  for (const side of sides) {
    const lever = side.turn && o.leverB ? o.leverB : o.lever;
    const place1 = (m: Mesh): Mesh => {
      const turned = side.turn ? place(m, rotY(180)) : m;
      return swing(turned, px, py, side.angle);
    };
    const add = (
      name: string,
      role: string,
      material: Material,
      list: readonly Mesh[],
      crease?: number,
    ): void => {
      const m = merged(list.map(place1));
      if (m) parts.push({ name, role, material, mesh: m, ...(crease ? { crease } : {}) });
    };
    add(`jaw-${side.jaw}`, 'jaw', o.mats.metal, lever.metal, 40);
    if (lever.faces.length) add(`jaw-${side.jaw}-teeth`, 'jaw-face', o.mats.face, lever.faces, 20);
    if (lever.edges.length) add(`cutter-${side.jaw}`, 'blade', o.mats.edge, lever.edges, 30);
    if (lever.sleeve) add(`handle-${side.handle}`, 'handle', o.mats.sleeve, [lever.sleeve], 60);
    if (lever.bare) add(`handle-${side.handle}`, 'handle', o.mats.metal, [lever.bare], 40);
    if (lever.inserts.length) add(`grip-${side.handle}`, 'grip', o.mats.insert, lever.inserts, 60);
  }
  parts.push({
    name: 'pivot',
    role: 'pivot',
    material: o.mats.pivot,
    mesh: place(o.rivet, at(px, py, 0)),
    crease: 30,
  });
  if (o.extra) parts.push(...o.extra);
  return parts;
}

/**
 * Opening distance between the jaw tips for an opening angle: both tips travel on a circle of radius
 * `tipRadius` around the pivot.
 */
export function tipGap(tipRadius: number, openDeg: number, innerGap = 0): number {
  return innerGap + 2 * tipRadius * Math.sin((openDeg / 2) * DEG);
}

/** Linear scale of x, y of an outline list. */
export function scalePts(pts: readonly Pt[], k: number): Pt[] {
  return pts.map((p) => [p[0] * k, p[1] * k, p[2] === undefined ? undefined : p[2] * k] as Pt);
}

/** Extrusion with the closed-outline convenience wrapper used for lever plates. */
export function plateMesh(
  pts: readonly Pt[],
  z0: number,
  z1: number,
  bevel: { back?: number; front?: number },
  steps = 4,
  holes: readonly (readonly V2[])[] = [],
): Mesh {
  return extrude(roundedOutline(pts, steps), z0, z1, {
    bevelBack: bevel.back ?? 0,
    bevelFront: bevel.front ?? 0,
    holes,
  });
}

/**
 * Cutter blade: lofted wedge with a narrow flat cutting face on x = 0 that widens through two bevel facets
 * into a rounded back. `ctrl` rows are [y, width, half thickness]; the nose can be swept back towards the
 * faces (`noseDeg`, the "diagonal" tip) by pulling vertices at |z| towards -y.
 */
export function wedgeLoft(
  ctrl: readonly (readonly [number, number, number])[],
  options: {
    edge?: number;
    bevelFrac?: number;
    backPoints?: number;
    perSegment?: number;
    noseDeg?: number;
  } = {},
): Mesh {
  const edge = options.edge ?? 0.5;
  const frac = options.bevelFrac ?? 0.42;
  const m = options.backPoints ?? 7;
  const ys = smoothCurve(
    ctrl.map((c) => [c[0], c[1]] as V2),
    options.perSegment ?? 3,
  );
  const ts = smoothCurve(
    ctrl.map((c) => [c[0], c[2]] as V2),
    options.perSegment ?? 3,
  );
  const stations: Station[] = ys.map(([y, w], i) => {
    const t = (ts[i] as V2)[1];
    const b = w * frac;
    const ring: V2[] = [
      [0, -edge],
      [0, edge],
    ];
    for (let j = 0; j < m; j++) {
      const a = Math.PI / 2 - (Math.PI * j) / (m - 1);
      const c = Math.cos(a);
      const sn = Math.sin(a);
      ring.push([b + (w - b) * Math.abs(c) ** 0.7, t * Math.sign(sn) * Math.abs(sn) ** 0.75]);
    }
    return { y, ring: ring.map(([x, z]) => [Math.max(0, x), z] as V2) };
  });
  const mesh = loft(stations);
  const k = Math.tan((options.noseDeg ?? 0) * DEG);
  if (k === 0) return mesh;
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 1] = (positions[i + 1] as number) - Math.abs(positions[i + 2] as number) * k;
  }
  return { positions, indices: mesh.indices };
}

/** Flat bent spring strip along a plan-view polyline (thickness along z, width in plan), rounded corners. */
export function stripSpring(
  path: readonly V2[],
  halfWidth: number,
  halfThickness: number,
  corner: number,
  sides: number,
): Mesh {
  const pts: V3[] = path.map(([x, y]) => [x, y, 0]);
  const smooth = roundedPath(pts, corner, 6);
  return tube(smooth, [halfThickness, halfWidth], { sides, up: [0, 0, 1] });
}

/** Resample an open polyline into `count` + 1 points evenly spaced along its length. */
export function resamplePolyline(path: readonly V2[], count: number): V2[] {
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as V2;
    const b = path[i] as V2;
    cum.push((cum[i - 1] as number) + hyp(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[cum.length - 1] as number;
  const out: V2[] = [];
  let j = 0;
  for (let i = 0; i <= count; i++) {
    const s = (total * i) / count;
    while (j < path.length - 2 && (cum[j + 1] as number) < s) j++;
    const a = path[j] as V2;
    const b = path[j + 1] as V2;
    const span = (cum[j + 1] as number) - (cum[j] as number) || 1;
    const u = Math.min(1, Math.max(0, (s - (cum[j] as number)) / span));
    out.push([lerp(a[0], b[0], u), lerp(a[1], b[1], u)]);
  }
  return out;
}

/**
 * Serrated strip along an arbitrary edge polyline: teeth grow from the edge towards `side` * (left normal
 * of the path direction) by `depth`; the strip reaches `back` mm into the body behind the edge.
 */
export function toothedEdge(
  path: readonly V2[],
  pitch: number,
  depth: number,
  side: 1 | -1,
  back = 0.7,
): V2[] {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1] as V2;
    const b = path[i] as V2;
    len += hyp(b[0] - a[0], b[1] - a[1]);
  }
  const n = Math.max(2, 2 * Math.round(len / pitch));
  const pts = resamplePolyline(path, n);
  const normalAt = (i: number): V2 => {
    const a = pts[Math.max(0, i - 1)] as V2;
    const b = pts[Math.min(n, i + 1)] as V2;
    const tx = b[0] - a[0];
    const ty = b[1] - a[1];
    const l = hyp(tx, ty) || 1;
    return [(-ty / l) * side, (tx / l) * side];
  };
  const front: V2[] = [];
  const rear: V2[] = [];
  for (let i = 0; i <= n; i++) {
    const p = pts[i] as V2;
    const nm = normalAt(i);
    const d = i % 2 === 1 ? depth : 0;
    front.push([p[0] + nm[0] * d, p[1] + nm[1] * d]);
    rear.push([p[0] - nm[0] * back, p[1] - nm[1] * back]);
  }
  return [...front, ...rear.reverse()];
}
