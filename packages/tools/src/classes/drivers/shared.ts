/**
 * Shared helpers of the `drivers` family: bent-bar sweep (hex keys), plane remaps for flat prisms, hex
 * rings, metal finishes and the hinged flip-top case shared by the bit case and the drill-bit case.
 */
import { type V2, compose, translation, rotationY } from '../../math.ts';
import { type Material, plastic, translucentPlastic } from '../../materials.ts';
import { type Mesh, ensureOutward, mergeMeshes, transformMesh } from '../../mesh.ts';
import type { Part } from '../../model.ts';
import { at, box, cylinder, extrude } from '../../build/primitives.ts';
import { polygonRing, roundedRectRing } from '../../build/rings.ts';
import type { BuildCtx } from '../../registry.ts';

/** 1/4 in hex drive: across flats, mm. */
export const HEX_QUARTER = 6.35;

export const TITANIUM: Material = {
  name: 'titanium nitride',
  kind: 'metal',
  color: '#d2a53c',
  metallic: 1,
  roughness: 0.26,
  alpha: 1,
};

export const BRONZE_OXIDE: Material = {
  name: 'bronze oxide',
  kind: 'metal',
  color: '#8d6b3a',
  metallic: 1,
  roughness: 0.34,
  alpha: 1,
};

/** Hex ring with a vertex on +x; `af` is the across-flats size. */
export function hexRing(af: number, count: number): V2[] {
  return polygonRing(6, af / 2 / Math.cos(Math.PI / 6), count, true);
}

export const hexCircumRadius = (af: number): number => af / 2 / Math.cos(Math.PI / 6);

/** One frame of a planar sweep: ring centre in the XY plane, unit tangent in the XY plane. */
export interface SweepStation {
  c: V2;
  t: V2;
  ring: readonly V2[];
}

/**
 * Sweep a ring (a = in-plane normal, b = Z) along a planar path in the XY plane. Same index layout as
 * `loft`, closed with centroid fans at both ends.
 */
export function sweepPlanar(stations: readonly SweepStation[]): Mesh {
  const n = (stations[0] as SweepStation).ring.length;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const st of stations) {
    if (st.ring.length !== n) throw new Error('sweepPlanar: ring size changes');
    const ux = -st.t[1];
    const uy = st.t[0];
    for (const [a, b] of st.ring) positions.push(st.c[0] + a * ux, st.c[1] + a * uy, b);
  }
  for (let s = 0; s < stations.length - 1; s++) {
    const a = s * n;
    const b = (s + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(a + i, a + j, b + j);
      indices.push(a + i, b + j, b + i);
    }
  }
  const cap = (s: number, flip: boolean): void => {
    const c = positions.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let i = 0; i < n; i++) {
      cx += positions[(s * n + i) * 3] ?? 0;
      cy += positions[(s * n + i) * 3 + 1] ?? 0;
      cz += positions[(s * n + i) * 3 + 2] ?? 0;
    }
    positions.push(cx / n, cy / n, cz / n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) indices.push(c, s * n + j, s * n + i);
      else indices.push(c, s * n + i, s * n + j);
    }
  };
  cap(0, true);
  cap(stations.length - 1, false);
  return ensureOutward({ positions, indices });
}

/** Mesh built as an XY prism (u, v, thickness w) re-expressed with the thickness along X: (w, u, v). */
export function planeYZ(mesh: Mesh): Mesh {
  return transformMesh(mesh, [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0]);
}

/** Mesh built as an XY prism (u, v, thickness w) re-expressed with the thickness along Y: (u, w, v). */
export function planeXZ(mesh: Mesh): Mesh {
  return transformMesh(mesh, [1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
}

/**
 * Block whose top face carries semicircular grooves. `rows` are groove centre coordinates with radii along
 * the first axis; the block spans [a0, a1] along that axis, from `zBottom` to `zTop` on the second axis,
 * and `w0..w1` along the extrusion axis. Returned in prism space (u = row axis, v = height, w = length).
 */
export function grooveBlock(
  a0: number,
  a1: number,
  zBottom: number,
  zTop: number,
  grooves: readonly { c: number; r: number }[],
  w0: number,
  w1: number,
  arcSteps: number,
): Mesh {
  const outline: V2[] = [
    [a0, zBottom],
    [a1, zBottom],
    [a1, zTop],
  ];
  for (let k = grooves.length - 1; k >= 0; k--) {
    const g = grooves[k] as { c: number; r: number };
    // half-round groove: centre on the rib-top plane, opening 2r wide, depth r
    const zc = zTop;
    for (let s = 0; s <= arcSteps; s++) {
      const a = (s / arcSteps) * Math.PI;
      outline.push([g.c + g.r * Math.cos(a), zc - g.r * Math.sin(a)]);
    }
  }
  outline.push([a0, zTop]);
  return extrude(outline, w0, w1);
}

export interface HingedCaseSpec {
  width: number;
  length: number;
  baseHeight: number;
  lidHeight: number;
  open: boolean;
  openAngle: number;
  base: Material;
  lid: Material;
  accent: Material;
  corner: number;
}

export interface HingedCase {
  parts: Part[];
  /** Inner cavity of the base. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Z of the floor surface and of the rim. */
  zFloor: number;
  zRim: number;
  wall: number;
}

export const WALL = 1.8;
export const FLOOR = 1.6;
const PLATE = 1.6;

const shiftY = (ring: readonly V2[], dy: number): V2[] => ring.map(([x, y]) => [x, y + dy]);

/**
 * Hinged flip-top box: base, lid, three hinge knuckles on the +x long edge, a snap latch on the -x edge.
 * Z is centred so that the closed case straddles z = 0; `open` swings the lid over the hinge.
 */
export function hingedCase(spec: HingedCaseSpec, ctx: BuildCtx): HingedCase {
  const { width: W, length: L, baseHeight, lidHeight } = spec;
  const per = ctx.seg(5, 2);
  const outer = shiftY(roundedRectRing(W, L, spec.corner, per), L / 2);
  const inner = shiftY(
    roundedRectRing(W - 2 * WALL, L - 2 * WALL, Math.max(spec.corner - WALL, 0.5), per),
    L / 2,
  );
  const z0 = -(baseHeight + lidHeight) / 2;
  const zRim = z0 + baseHeight;
  const zTop = zRim + lidHeight;

  const baseMesh = mergeMeshes([
    extrude(outer, z0, z0 + FLOOR, { bevelBack: 0.9 }),
    extrude(outer, z0 + 0.9, zRim, { holes: [inner], bevelFront: 0.45 }),
  ]);
  const lidMesh = mergeMeshes([
    extrude(outer, zTop - PLATE, zTop, { bevelFront: 0.75 }),
    extrude(outer, zRim, zTop - PLATE / 2, { holes: [inner], bevelBack: 0.4 }),
  ]);

  const hx = W / 2 - 0.2;
  const hz = zRim - 0.1;
  const swing = spec.open
    ? compose(translation(hx, 0, hz), compose(rotationY(spec.openAngle), translation(-hx, 0, -hz)))
    : null;
  const lidMoved = (m: Mesh): Mesh => (swing ? transformMesh(m, swing) : m);

  const knuckleLen = L * 0.16;
  const knuckles = [0.2, 0.5, 0.8].map((f) =>
    transformMesh(cylinder(2.2, knuckleLen, ctx.seg(20, 10)), at(hx, L * f, hz)),
  );
  const lx = -W / 2;
  const catchMesh = transformMesh(box(1.6, 12, 2.2, 0.4, 1), at(lx - 0.5, L / 2, zRim - 1.3));
  const hookMesh = mergeMeshes([
    transformMesh(box(1.2, 12, 6, 0.4, 1), at(lx - 2.0, L / 2, zRim - 0.4)),
    transformMesh(box(3.4, 12, 2, 0.4, 1), at(lx - 0.8, L / 2, zRim + 1.6)),
  ]);

  const parts: Part[] = [
    { name: 'base', role: 'body', material: spec.base, mesh: baseMesh, crease: 40 },
    { name: 'lid', role: 'lid', material: spec.lid, mesh: lidMoved(lidMesh), crease: 40 },
    { name: 'hinge', role: 'hinge', material: spec.base, mesh: mergeMeshes(knuckles), crease: 50 },
    { name: 'catch', role: 'latch', material: spec.accent, mesh: catchMesh, crease: 40 },
    { name: 'hook', role: 'latch', material: spec.accent, mesh: lidMoved(hookMesh), crease: 40 },
  ];
  return {
    parts,
    x0: -W / 2 + WALL,
    x1: W / 2 - WALL,
    y0: WALL,
    y1: L - WALL,
    zFloor: z0 + FLOOR,
    zRim,
    wall: WALL,
  };
}

/** Lid material for clear / smoked / solid lids. */
export function lidMaterial(style: 'clear' | 'smoke' | 'solid', color: string): Material {
  if (style === 'clear') return translucentPlastic(color, 0.38, 'clear lid');
  if (style === 'smoke') return translucentPlastic('#2c3036', 0.62, 'smoked lid');
  return plastic(color, 0.4, 'lid plastic');
}

/** Dark moulded insert of a case. */
export const INSERT_MATERIAL: Material = plastic('#2b2d31', 0.7, 'tray insert');
