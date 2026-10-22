/**
 * Crossed-lever pliers: turns outline lists (lever A in the closed pose) plus a handle spec into the
 * two-lever assembly, with the finish / colour materials shared by the whole family.
 */
import { type Material, METALS, plastic, rubber } from '../../materials.ts';
import type { Part, Zone } from '../../model.ts';
import { boundsOfParts } from '../../model.ts';
import type { BuildCtx } from '../../registry.ts';
import { L, choice, color } from '../../params.ts';
import { type V2, DEG } from '../../math.ts';
import { at, extrude, place } from '../../build/primitives.ts';
import { type Mesh, mergeMeshes } from '../../mesh.ts';
import { type HandleSpec, buildHandle } from './handles.ts';
import {
  type CrossingMaterials,
  type LeverMeshes,
  type Pt,
  type Spine,
  assembleCrossing,
  plateMesh,
  rivetMesh,
  spineAt,
  stripSpring,
} from './kit.ts';

export const FINISHES = ['polished', 'chrome', 'forged', 'blackOxide'] as const;
export type Finish = (typeof FINISHES)[number];

export const finishSchema = {
  finish: choice(L('Head finish', 'Покрытие головки'), FINISHES, 'polished'),
  handleColor: color(L('Handle colour', 'Цвет рукоятей'), '#c8262b'),
  gripColor: color(L('Grip insert colour', 'Цвет вставок'), '#1b1c1e'),
};

export function headMaterial(finish: Finish): Material {
  switch (finish) {
    case 'polished':
      return { ...METALS.polishedSteel, name: 'polished forged steel' };
    case 'chrome':
      return METALS.chrome;
    case 'forged':
      return { ...METALS.darkSteel, name: 'forged steel' };
    case 'blackOxide':
      return METALS.blackOxide;
  }
}

export function crossingMaterials(
  finish: Finish,
  handleColor: string,
  gripColor: string,
  comfort: boolean,
): CrossingMaterials {
  const sleeve = (c: string): Material =>
    comfort ? plastic(c, 0.45, 'two-component handle') : plastic(c, 0.33, 'PVC dip');
  return {
    metal: headMaterial(finish),
    face: METALS.steel,
    edge: { ...METALS.polishedSteel, name: 'ground cutting edge' },
    sleeve: sleeve(handleColor),
    insert: rubber(gripColor, 'ribbed', 'soft grip insert'),
    pivot: METALS.steel,
  };
}

/** Geometry of the metal part of lever A in the closed pose. */
export interface LeverGeometry {
  /** Total head thickness (z), each lever plate is half of it where the levers cross. */
  T: number;
  bevel: number;
  /** Full outline (back layer, z -T/2..0) and the front-layer pieces (z 0..T/2). */
  plate: readonly Pt[];
  front: readonly (readonly Pt[])[];
  steps?: number;
  /** Extra shells already positioned in the A frame. */
  metal?: readonly Mesh[];
  faces?: readonly Mesh[];
  edges?: readonly Mesh[];
}

export function leverMeshes(
  g: LeverGeometry,
  handle: ReturnType<typeof buildHandle> | null,
): LeverMeshes {
  const h = g.T / 2;
  const steps = g.steps ?? 4;
  const metal: Mesh[] = [plateMesh(g.plate, -h, 0, { back: g.bevel }, steps)];
  for (const piece of g.front) metal.push(plateMesh(piece, 0, h, { front: g.bevel }, steps));
  if (g.metal) metal.push(...g.metal);
  return {
    metal,
    faces: [...(g.faces ?? [])],
    edges: [...(g.edges ?? [])],
    sleeve: handle?.sleeve ?? null,
    inserts: handle?.inserts ?? [],
    bare: handle?.bare ?? null,
  };
}

export interface CrossingBuild {
  geometry: LeverGeometry;
  /** Separate handle sleeves; omit when the handle is part of the lever outline (plastic levers). */
  handle?: HandleSpec;
  /** Overrides of the head / lever materials (plastic spring clamp levers, rubber tips). */
  metalMaterial?: Material;
  faceMaterial?: Material;
  pivot: V2;
  pivotRadius: number;
  openDeg: number;
  finish: Finish;
  handleColor: string;
  gripColor: string;
  ctx: BuildCtx;
  /** Parts that come after the levers (spring, lock...). */
  extra?: Part[];
  /** Lever B built separately (jaws that curve, offset or angle differently), see `assembleCrossing`. */
  geometryB?: LeverGeometry;
}

export function buildCrossing(b: CrossingBuild): Part[] {
  const hd = b.handle ? buildHandle(b.handle, b.ctx) : null;
  const lever = leverMeshes(b.geometry, hd);
  const leverB = b.geometryB ? leverMeshes(b.geometryB, hd) : undefined;
  const mats = crossingMaterials(
    b.finish,
    b.handleColor,
    b.gripColor,
    b.handle?.style === 'comfort',
  );
  if (b.metalMaterial) mats.metal = b.metalMaterial;
  if (b.faceMaterial) mats.face = b.faceMaterial;
  return assembleCrossing({
    pivot: b.pivot,
    openDeg: b.openDeg,
    lever,
    rivet: rivetMesh(b.pivotRadius, b.geometry.T, b.ctx.seg(20, 10)),
    mats,
    ...(b.extra ? { extra: b.extra } : {}),
    ...(leverB ? { leverB } : {}),
  });
}

/** Common dims derived from the generated parts (width and thickness of the pose). */
export function poseDims(parts: readonly Part[]): { width: number; thickness: number } {
  const b = boundsOfParts(parts);
  return { width: b.max[0] - b.min[0], thickness: b.max[2] - b.min[2] };
}

export function zonesFor(handleTop: number, pivotY: number, length: number): Zone[] {
  return [
    { name: 'handle', y0: 0, y1: handleTop },
    { name: 'neck', y0: handleTop, y1: pivotY },
    { name: 'jaws', y0: pivotY, y1: length },
  ];
}

/**
 * Scissor crossing of the two levers (lever A, jaw on +x): returns the outline pieces that depend only on
 * the crossing. Lever B is A turned 180 degrees about Y, so the lower-right line of A and the mirrored
 * line of B meet on the axis at `x`-axis crossing `yX`.
 */
export interface CrossingFrame {
  /** Bottom of the neck (inside the handle sleeve). */
  y0: number;
  /** Inner / outer x of the neck bottom (tang). */
  xi: number;
  xo: number;
  /** Shoulder: head half width at height yS. */
  xh: number;
  yS: number;
  /** Where the lower-right line of A ends on the outer edge. */
  y1: number;
  /** Crotch height (top of the crossing on the axis). */
  yC: number;
  /** Raises the middle of the upper diagonal (organic head shape). */
  diagBulge?: number;
}

export interface CrossingPieces {
  /** S_R .. down to the neck bottom .. S_L .. diagonal .. crotch (open polyline, A's lower half). */
  lower: Pt[];
  /** Crotch .. back along the mirrored diagonal to S_R (closes the front jaw piece). */
  diagBack: Pt[];
  sR: Pt;
  /** Front-layer neck piece (A's part not covered by B). */
  neck: Pt[];
  yX: number;
}

export function crossingPieces(f: CrossingFrame): CrossingPieces {
  const edgeX = (y: number): number => f.xo + ((f.xh - f.xo) * (y - f.y0)) / (f.yS - f.y0);
  const xe = edgeX(f.y1);
  const yX = f.y0 + (f.xi / (f.xi + xe)) * (f.y1 - f.y0);
  const bulge = f.diagBulge ?? 0;
  const mx = f.xh * 0.45;
  const my = f.yS + ((f.yC - f.yS) * (f.xh - mx)) / f.xh + bulge;
  const sR: Pt = [f.xh, f.yS, 6];
  return {
    sR,
    yX,
    lower: [
      [xe, f.y1, 3],
      [-f.xi, f.y0],
      [-f.xo, f.y0],
      [-f.xh, f.yS, 2],
      [-mx, my],
      [0, f.yC],
    ],
    diagBack: [[mx, my]],
    neck: [
      [-f.xo, f.y0],
      [-f.xi, f.y0],
      [0, yX],
      [-xe, f.y1],
    ],
  };
}

/**
 * Points on the inner faces of both handles at arc length `s` of the handle spine, in the posed tool
 * (what a spring or latch between the handles attaches to). Lever A is the one with the handle on the left.
 */
export function innerFacePoints(
  spine: Spine,
  s: number,
  halfWidth: number,
  pivot: V2,
  openDeg: number,
): { a: V2; b: V2 } {
  const p = spineAt(spine, s);
  const q0 = spineAt(spine, s - 0.5);
  const q1 = spineAt(spine, s + 0.5);
  const tx = q1[0] - q0[0];
  const ty = q1[1] - q0[1];
  const tl = Math.hypot(tx, ty) || 1;
  let nx = ty / tl;
  let ny = -tx / tl;
  if (nx < 0) {
    nx = -nx;
    ny = -ny;
  }
  const ax = p[0] + nx * halfWidth;
  const ay = p[1] + ny * halfWidth;
  const half = (openDeg / 2) * (Math.PI / 180);
  const rot = (x: number, y: number, ang: number): V2 => {
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    return [
      pivot[0] + dx * Math.cos(ang) - dy * Math.sin(ang),
      pivot[1] + dx * Math.sin(ang) + dy * Math.cos(ang),
    ];
  };
  return { a: rot(ax, ay, -half), b: rot(-ax, ay, half) };
}

/** V-shaped return spring between the two handles (zinc strip, ends sunk into the inner faces). */
export function vSpring(
  spine: Spine,
  s: number,
  halfWidth: number,
  pivot: V2,
  openDeg: number,
  ctx: BuildCtx,
  rise = 16,
): Part {
  const { a, b } = innerFacePoints(spine, s, halfWidth - 1, pivot, openDeg);
  const apexY = (a[1] + b[1]) / 2 + rise + openDeg * 0.2;
  return {
    name: 'spring',
    role: 'spring',
    material: METALS.zinc,
    mesh: stripSpring([a, [(a[0] + b[0]) / 2, apexY], b], 3.4, 0.7, 3, ctx.seg(8, 6)),
    crease: 30,
  };
}

/** Flat bar between two plan-view points (link, latch). */
export function barMesh(a: V2, b: V2, half: number, z0: number, z1: number): Mesh {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = (-dy / l) * half;
  const ny = (dx / l) * half;
  return extrude(
    [
      [a[0] + nx, a[1] + ny],
      [a[0] - nx, a[1] - ny],
      [b[0] - nx, b[1] - ny],
      [b[0] + nx, b[1] + ny],
    ],
    z0,
    z1,
    { bevel: 0.3 },
  );
}

/** Round pin (12-sided prism along z) at a plan-view point. */
export function pinMesh(q: V2, r = 2.3, half = 2.6): Mesh {
  const ring: V2[] = [];
  for (let i = 0; i < 12; i++)
    ring.push([r * Math.cos((i / 12) * 2 * Math.PI), r * Math.sin((i / 12) * 2 * Math.PI)]);
  return place(extrude(ring, -half, half, { bevel: 0.4 }), at(q[0], q[1], 0));
}

/**
 * Hook latch at the butt: pinned on the left handle's inner face at arc length `s`; it spans to the right
 * handle while the tool is closed and hangs down along the handle when open.
 */
export function latchPart(
  spine: Spine,
  s: number,
  halfWidth: number,
  pivot: V2,
  openDeg: number,
  z0: number,
  hangLength: number,
): Part {
  const lt = innerFacePoints(spine, s, halfWidth - 0.5, pivot, openDeg);
  const end: V2 =
    openDeg < 2
      ? lt.b
      : [lt.a[0] + Math.sin(-8 * DEG) * hangLength, lt.a[1] - Math.cos(8 * DEG) * hangLength];
  return {
    name: 'latch',
    role: 'latch',
    material: METALS.blackOxide,
    mesh: mergeMeshes([barMesh(lt.a, end, 2.8, z0, z0 + 2), pinMesh(lt.a, 2.3, z0 + 2)]),
    crease: 30,
  };
}
