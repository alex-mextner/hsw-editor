/**
 * The product of a generator: named parts with materials, plus the holding interface a holder has to
 * fit. Frame (all mm): origin on the principal axis at the butt end, +Y towards the working end, +Z
 * towards the viewer when the tool lies face-up, +X right (the wall frame of `packages/core`).
 */
import { type Bounds, type V3, clamp } from './math.ts';
import type { Material } from './materials.ts';
import {
  type Mesh,
  type MeshReport,
  analyzeMesh,
  boundsOf,
  mergeBounds,
  triangleCount,
} from './mesh.ts';
import type { AnyValues } from './params.ts';

export type Lod = 0 | 1;

export interface Part {
  /** Unique within the tool, e.g. `handle`, `shaft`, `tip`, `jaw-left`. */
  name: string;
  /** Semantic role used for colour sampling and fitting: handle, shaft, head, blade, body, grip, label... */
  role: string;
  material: Material;
  mesh: Mesh;
  /** Crease angle (deg) for smooth shading; default 50. */
  crease?: number;
}

export interface HangPoint {
  point: V3;
  kind: 'hole' | 'loop' | 'butt' | 'head' | 'body' | 'neck';
  diameterMm?: number;
}

export interface Zone {
  name: string;
  y0: number;
  y1: number;
}

export interface ZoneStats extends Zone {
  /** Largest x / z extent and largest distance from the axis inside the zone. */
  maxWidth: number;
  maxThickness: number;
  maxRadius: number;
}

export interface SectionSample {
  y: number;
  /** Extent along x and z of the material cut at this y, and the farthest point from the axis. */
  w: number;
  t: number;
  r: number;
}

export interface HoldingInterface {
  /** Principal axis: always through the origin along +Y in the tool frame. */
  axis: { origin: V3; direction: V3 };
  lengthMm: number;
  hang: HangPoint | null;
  zones: ZoneStats[];
  /** Cross-section extents sampled every `stepMm` along the axis (what a holder has to fit). */
  profile: { stepMm: number; samples: SectionSample[] };
  /** The largest section over the whole tool. */
  maxSection: SectionSample;
  /** Class-specific measured dimensions for bank `fitsTool` hints (shaftDiameter, handleDiameter, ...). */
  dims: Record<string, number>;
}

export interface ToolModel {
  classId: string;
  params: AnyValues;
  lod: Lod;
  parts: Part[];
  bounds: Bounds;
  holding: HoldingInterface;
  triangles: number;
}

/** Return type of a class `build`. */
export interface BuiltTool {
  parts: Part[];
  hang?: HangPoint;
  zones: Zone[];
  dims: Record<string, number>;
}

export function boundsOfParts(parts: readonly Part[]): Bounds {
  return mergeBounds(parts.map((p) => boundsOf(p.mesh)));
}

export function totalTriangles(parts: readonly Part[]): number {
  return parts.reduce((a, p) => a + triangleCount(p.mesh), 0);
}

/** Sections of one mesh at height y: x extent, z extent, max distance from the Y axis. */
function sliceExtents(
  mesh: Mesh,
  y: number,
  acc: { minX: number; maxX: number; minZ: number; maxZ: number; r: number },
): void {
  const idx = mesh.indices;
  const pos = mesh.positions;
  for (let t = 0; t < idx.length; t += 3) {
    const ia = (idx[t] ?? 0) * 3;
    const ib = (idx[t + 1] ?? 0) * 3;
    const ic = (idx[t + 2] ?? 0) * 3;
    const ya = pos[ia + 1] ?? 0;
    const yb = pos[ib + 1] ?? 0;
    const yc = pos[ic + 1] ?? 0;
    if (Math.min(ya, yb, yc) > y || Math.max(ya, yb, yc) < y) continue;
    const corners = [ia, ib, ic];
    for (let e = 0; e < 3; e++) {
      const i0 = corners[e] as number;
      const i1 = corners[(e + 1) % 3] as number;
      const y0 = pos[i0 + 1] ?? 0;
      const y1 = pos[i1 + 1] ?? 0;
      if ((y0 - y) * (y1 - y) > 0 || y0 === y1) {
        if (y0 === y1 && y0 === y) {
          for (const i of [i0, i1]) take(pos[i] ?? 0, pos[i + 2] ?? 0, acc);
        }
        continue;
      }
      const u = (y - y0) / (y1 - y0);
      take(
        (pos[i0] ?? 0) + ((pos[i1] ?? 0) - (pos[i0] ?? 0)) * u,
        (pos[i0 + 2] ?? 0) + ((pos[i1 + 2] ?? 0) - (pos[i0 + 2] ?? 0)) * u,
        acc,
      );
    }
  }
}

function take(
  x: number,
  z: number,
  acc: { minX: number; maxX: number; minZ: number; maxZ: number; r: number },
): void {
  acc.minX = Math.min(acc.minX, x);
  acc.maxX = Math.max(acc.maxX, x);
  acc.minZ = Math.min(acc.minZ, z);
  acc.maxZ = Math.max(acc.maxZ, z);
  acc.r = Math.max(acc.r, Math.hypot(x, z));
}

/** Cross-section samples of all parts along +Y between y0 and y1. */
export function sectionProfile(
  parts: readonly Part[],
  y0: number,
  y1: number,
  stepMm: number,
): SectionSample[] {
  const out: SectionSample[] = [];
  const n = Math.max(1, Math.ceil((y1 - y0) / stepMm));
  for (let i = 0; i <= n; i++) {
    const y = clamp(y0 + (i * (y1 - y0)) / n, y0 + 1e-4, y1 - 1e-4);
    const acc = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, r: 0 };
    for (const p of parts) sliceExtents(p.mesh, y, acc);
    if (acc.maxX < acc.minX) out.push({ y, w: 0, t: 0, r: 0 });
    else out.push({ y, w: acc.maxX - acc.minX, t: acc.maxZ - acc.minZ, r: acc.r });
  }
  return out;
}

export function buildHolding(built: BuiltTool, bounds: Bounds, stepMm = 2): HoldingInterface {
  const y0 = bounds.min[1];
  const y1 = bounds.max[1];
  const samples = sectionProfile(built.parts, y0, y1, stepMm);
  const zones: ZoneStats[] = built.zones.map((z) => {
    const inZone = sectionProfile(built.parts, z.y0, z.y1, Math.max(0.5, (z.y1 - z.y0) / 12));
    return {
      ...z,
      maxWidth: Math.max(0, ...inZone.map((s) => s.w)),
      maxThickness: Math.max(0, ...inZone.map((s) => s.t)),
      maxRadius: Math.max(0, ...inZone.map((s) => s.r)),
    };
  });
  const maxSection = samples.reduce<SectionSample>((a, s) => (s.r > a.r ? s : a), {
    y: 0,
    w: 0,
    t: 0,
    r: 0,
  });
  return {
    axis: { origin: [0, 0, 0], direction: [0, 1, 0] },
    lengthMm: y1 - Math.min(0, y0),
    hang: built.hang ?? null,
    zones,
    profile: { stepMm, samples },
    maxSection,
    dims: built.dims,
  };
}

/**
 * Largest circumscribed diameter the tool presents between `yFrom` and `yTo` (what a round holder hole
 * must clear when the tool is pushed in along its axis over that stretch).
 */
export function maxDiameterBetween(h: HoldingInterface, yFrom: number, yTo: number): number {
  const lo = Math.min(yFrom, yTo);
  const hi = Math.max(yFrom, yTo);
  let r = 0;
  for (const s of h.profile.samples) if (s.y >= lo && s.y <= hi) r = Math.max(r, s.r);
  return 2 * r;
}

export function checkModel(model: ToolModel): { part: string; report: MeshReport }[] {
  return model.parts.map((p) => ({ part: p.name, report: analyzeMesh(p.mesh) }));
}
