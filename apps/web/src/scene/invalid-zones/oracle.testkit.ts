/**
 * Brute-force reference used by the engine tests to cross-check the boolean engine without sharing any of
 * its code: a point is inside a closed triangle mesh when a ray from it crosses the surface an odd number of times,
 * and its depth is the distance to the nearest triangle.
 */
import { poseMatrix, type Pose } from '@hsw-editor/core';
import type { SolidMesh } from './engine.ts';

type V3 = readonly [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function vertex(mesh: SolidMesh, index: number): V3 {
  const i = (mesh.indices[index] ?? 0) * 3;
  return [mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0];
}

/** Ray direction chosen to avoid axis-aligned edges and faces of CAD meshes. */
const RAY: V3 = [0.5773502691896258, 0.5773502691896258 + 1e-3, 0.5773502691896258 - 2e-3];

/** Moeller-Trumbore: does the ray from `origin` along RAY cross triangle (a, b, c)? */
function crosses(origin: V3, a: V3, b: V3, c: V3): boolean {
  const e1 = sub(b, a);
  const e2 = sub(c, a);
  const p = cross(RAY, e2);
  const det = dot(e1, p);
  if (Math.abs(det) < 1e-12) return false;
  const t = sub(origin, a);
  const u = dot(t, p) / det;
  if (u < 0 || u > 1) return false;
  const q = cross(t, e1);
  const v = dot(RAY, q) / det;
  if (v < 0 || u + v > 1) return false;
  return dot(e2, q) / det > 1e-9;
}

export function pointInsideMesh(mesh: SolidMesh, point: V3): boolean {
  let hits = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    if (crosses(point, vertex(mesh, t), vertex(mesh, t + 1), vertex(mesh, t + 2))) hits += 1;
  }
  return hits % 2 === 1;
}

/** Distance from `p` to triangle (a, b, c) (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDistance(p: V3, a: V3, b: V3, c: V3): number {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const closest = (q: V3): number => Math.hypot(...sub(p, q));
  if (d1 <= 0 && d2 <= 0) return closest(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return closest(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return closest([a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]);
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return closest(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return closest([a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]]);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return closest([b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]);
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return closest([
    a[0] + ab[0] * v + ac[0] * w,
    a[1] + ab[1] * v + ac[1] * w,
    a[2] + ab[2] * v + ac[2] * w,
  ]);
}

export function distanceToMesh(mesh: SolidMesh, point: V3): number {
  let best = Infinity;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    best = Math.min(
      best,
      pointTriangleDistance(point, vertex(mesh, t), vertex(mesh, t + 1), vertex(mesh, t + 2)),
    );
  }
  return best;
}

function toLocal(pose: Pose, world: V3): V3 {
  // Rigid inverse of poseMatrix: R^T (p - t).
  const m = poseMatrix(pose);
  const d = sub(world, [m[12], m[13], m[14]]);
  return [
    m[0] * d[0] + m[1] * d[1] + m[2] * d[2],
    m[4] * d[0] + m[5] * d[1] + m[6] * d[2],
    m[8] * d[0] + m[9] * d[1] + m[10] * d[2],
  ];
}

function toWorld(pose: Pose, local: V3): V3 {
  const m = poseMatrix(pose);
  return [
    m[0] * local[0] + m[4] * local[1] + m[8] * local[2] + m[12],
    m[1] * local[0] + m[5] * local[1] + m[9] * local[2] + m[13],
    m[2] * local[0] + m[6] * local[1] + m[10] * local[2] + m[14],
  ];
}

/**
 * Deepest vertex of `a` (posed) that lies inside `b` (posed), as a distance to b's surface; 0 when no vertex of
 * `a` is inside `b`. Vertex-in-solid is a sufficient (not necessary) witness of interpenetration.
 */
export function deepestVertexInside(a: SolidMesh, poseA: Pose, b: SolidMesh, poseB: Pose): number {
  let deepest = 0;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < b.positions.length; i += 1) {
    const axis = i % 3;
    lo[axis] = Math.min(lo[axis] ?? Infinity, b.positions[i] ?? 0);
    hi[axis] = Math.max(hi[axis] ?? -Infinity, b.positions[i] ?? 0);
  }
  for (let i = 0; i + 2 < a.positions.length; i += 3) {
    const world = toWorld(poseA, [
      a.positions[i] ?? 0,
      a.positions[i + 1] ?? 0,
      a.positions[i + 2] ?? 0,
    ]);
    const local = toLocal(poseB, world);
    if (local.some((value, axis) => value < (lo[axis] ?? 0) || value > (hi[axis] ?? 0))) continue;
    if (pointInsideMesh(b, local)) deepest = Math.max(deepest, distanceToMesh(b, local));
  }
  return deepest;
}
