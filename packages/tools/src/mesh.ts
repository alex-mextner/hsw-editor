/**
 * Indexed triangle meshes and the operations every generator needs: merge, transform, bounds, analysis
 * (watertightness, volume) and normal generation with a crease angle.
 *
 * Contract of every primitive in `build/`: the returned mesh is one closed, consistently oriented
 * (outward, counter-clockwise) shell whose seams share vertices. `analyzeMesh` checks exactly that.
 */
import { type Affine, type Bounds, type V3, applyAffine, determinant, DEG } from './math.ts';

export interface Mesh {
  /** Flat xyz in mm. */
  positions: number[];
  /** Triangle corner indices, counter-clockwise seen from outside. */
  indices: number[];
}

export function emptyMesh(): Mesh {
  return { positions: [], indices: [] };
}

export function vertexCount(mesh: Mesh): number {
  return mesh.positions.length / 3;
}

export function triangleCount(mesh: Mesh): number {
  return mesh.indices.length / 3;
}

export function vertexAt(mesh: Mesh, i: number): V3 {
  return [
    mesh.positions[i * 3] ?? 0,
    mesh.positions[i * 3 + 1] ?? 0,
    mesh.positions[i * 3 + 2] ?? 0,
  ];
}

export function mergeMeshes(meshes: readonly Mesh[]): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const m of meshes) {
    const base = positions.length / 3;
    for (const p of m.positions) positions.push(p);
    for (const i of m.indices) indices.push(i + base);
  }
  return { positions, indices };
}

/** Applies an affine map; a reflecting map (negative determinant) flips the winding to stay outward. */
export function transformMesh(mesh: Mesh, m: Affine): Mesh {
  const positions = new Array<number>(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = applyAffine(m, [
      mesh.positions[i] ?? 0,
      mesh.positions[i + 1] ?? 0,
      mesh.positions[i + 2] ?? 0,
    ]);
    positions[i] = p[0];
    positions[i + 1] = p[1];
    positions[i + 2] = p[2];
  }
  const flip = determinant(m) < 0;
  const indices = flip ? flipWinding(mesh.indices) : mesh.indices.slice();
  return { positions, indices };
}

export function flipWinding(indices: readonly number[]): number[] {
  const out = indices.slice();
  for (let i = 0; i < out.length; i += 3) {
    const t = out[i + 1] ?? 0;
    out[i + 1] = out[i + 2] ?? 0;
    out[i + 2] = t;
  }
  return out;
}

/** Signed volume (mm^3); positive for outward-oriented closed shells. */
export function signedVolume(mesh: Mesh): number {
  const p = mesh.positions;
  let v = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = (mesh.indices[i] ?? 0) * 3;
    const b = (mesh.indices[i + 1] ?? 0) * 3;
    const c = (mesh.indices[i + 2] ?? 0) * 3;
    const bx = p[b] ?? 0;
    const by = p[b + 1] ?? 0;
    const bz = p[b + 2] ?? 0;
    const cx = p[c] ?? 0;
    const cy = p[c + 1] ?? 0;
    const cz = p[c + 2] ?? 0;
    v +=
      ((p[a] ?? 0) * (by * cz - bz * cy) +
        (p[a + 1] ?? 0) * (bz * cx - bx * cz) +
        (p[a + 2] ?? 0) * (bx * cy - by * cx)) /
      6;
  }
  return v;
}

/** Flips the whole shell if it is inside out. */
export function ensureOutward(mesh: Mesh): Mesh {
  return signedVolume(mesh) < 0
    ? { positions: mesh.positions, indices: flipWinding(mesh.indices) }
    : mesh;
}

export function boundsOf(mesh: Mesh): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.positions[i + k] ?? 0;
      if (v < (min[k] ?? 0)) min[k] = v;
      if (v > (max[k] ?? 0)) max[k] = v;
    }
  }
  return { min, max };
}

export function mergeBounds(list: readonly Bounds[]): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? 0, b.min[k] ?? 0);
      max[k] = Math.max(max[k] ?? 0, b.max[k] ?? 0);
    }
  }
  return { min, max };
}

export interface MeshReport {
  triangles: number;
  vertices: number;
  /** Edges used by one triangle only. */
  openEdges: number;
  /** Edges used by more than two triangles, or twice in the same direction. */
  badEdges: number;
  degenerateTriangles: number;
  volumeMm3: number;
  /** Closed, manifold, consistently oriented, outward (positive volume). */
  watertight: boolean;
}

/**
 * Topological check on shared vertex indices (primitives share seam vertices, see the module comment).
 * Directed edge a->b must appear exactly once and b->a exactly once.
 */
export function analyzeMesh(mesh: Mesh): MeshReport {
  const directed = new Map<number, number>();
  const stride = vertexCount(mesh) + 1;
  let degenerate = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] ?? 0;
    const b = mesh.indices[i + 1] ?? 0;
    const c = mesh.indices[i + 2] ?? 0;
    if (a === b || b === c || a === c) {
      degenerate++;
      continue;
    }
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = u * stride + v;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  let bad = 0;
  for (const [key, count] of directed) {
    const u = Math.floor(key / stride);
    const v = key % stride;
    const reverse = directed.get(v * stride + u) ?? 0;
    if (count > 1) bad++;
    if (reverse === 0) open++;
    else if (reverse > 1) bad++;
  }
  const volume = signedVolume(mesh);
  return {
    triangles: triangleCount(mesh),
    vertices: vertexCount(mesh),
    openEdges: open,
    badEdges: bad,
    degenerateTriangles: degenerate,
    volumeMm3: volume,
    watertight: open === 0 && bad === 0 && volume > 0,
  };
}

export interface ShadedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/**
 * Per-corner smooth normals: corner normals are the area-weighted mean of the face normals of the
 * adjacent faces within `creaseDeg` of the face itself; vertices are split where the surface is creased.
 */
const shadeCache = new WeakMap<Mesh, Map<number, ShadedMesh>>();

export function shade(mesh: Mesh, creaseDeg = 50): ShadedMesh {
  const cached = shadeCache.get(mesh)?.get(creaseDeg);
  if (cached) return cached;
  const result = computeShade(mesh, creaseDeg);
  const perMesh = shadeCache.get(mesh) ?? new Map<number, ShadedMesh>();
  perMesh.set(creaseDeg, result);
  shadeCache.set(mesh, perMesh);
  return result;
}

function computeShade(mesh: Mesh, creaseDeg: number): ShadedMesh {
  const tri = mesh.indices.length / 3;
  const pos = mesh.positions;
  const idx = mesh.indices;
  const faceN = new Float64Array(tri * 3);
  for (let t = 0; t < tri; t++) {
    const a = (idx[t * 3] ?? 0) * 3;
    const b = (idx[t * 3 + 1] ?? 0) * 3;
    const c = (idx[t * 3 + 2] ?? 0) * 3;
    const ux = (pos[b] ?? 0) - (pos[a] ?? 0);
    const uy = (pos[b + 1] ?? 0) - (pos[a + 1] ?? 0);
    const uz = (pos[b + 2] ?? 0) - (pos[a + 2] ?? 0);
    const vx = (pos[c] ?? 0) - (pos[a] ?? 0);
    const vy = (pos[c + 1] ?? 0) - (pos[a + 1] ?? 0);
    const vz = (pos[c + 2] ?? 0) - (pos[a + 2] ?? 0);
    // length = 2 * area
    faceN[t * 3] = uy * vz - uz * vy;
    faceN[t * 3 + 1] = uz * vx - ux * vz;
    faceN[t * 3 + 2] = ux * vy - uy * vx;
  }
  const vertexFaces: number[][] = Array.from({ length: vertexCount(mesh) }, () => []);
  for (let t = 0; t < tri; t++) {
    for (let k = 0; k < 3; k++) vertexFaces[idx[t * 3 + k] ?? 0]?.push(t);
  }
  const cosCrease = Math.cos(creaseDeg * DEG);
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  // per source vertex: the split vertices created so far (distinct smoothed normals)
  const splits: { nx: number; ny: number; nz: number; index: number }[][] = Array.from(
    { length: vertexCount(mesh) },
    () => [],
  );
  for (let t = 0; t < tri; t++) {
    const fl = Math.hypot(faceN[t * 3] ?? 0, faceN[t * 3 + 1] ?? 0, faceN[t * 3 + 2] ?? 0) || 1;
    const fx = (faceN[t * 3] ?? 0) / fl;
    const fy = (faceN[t * 3 + 1] ?? 0) / fl;
    const fz = (faceN[t * 3 + 2] ?? 0) / fl;
    for (let k = 0; k < 3; k++) {
      const vi = idx[t * 3 + k] ?? 0;
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (const f of vertexFaces[vi] ?? []) {
        const gx = faceN[f * 3] ?? 0;
        const gy = faceN[f * 3 + 1] ?? 0;
        const gz = faceN[f * 3 + 2] ?? 0;
        const gl = Math.hypot(gx, gy, gz);
        if (gl < 1e-12) continue;
        if ((gx * fx + gy * fy + gz * fz) / gl >= cosCrease) {
          nx += gx;
          ny += gy;
          nz += gz;
        }
      }
      let nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-12) {
        nx = fx;
        ny = fy;
        nz = fz;
        nl = 1;
      }
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const list = splits[vi] as { nx: number; ny: number; nz: number; index: number }[];
      let found = list.find((s) => s.nx * nx + s.ny * ny + s.nz * nz > 0.99995);
      if (!found) {
        found = { nx, ny, nz, index: positions.length / 3 };
        list.push(found);
        positions.push(pos[vi * 3] ?? 0, pos[vi * 3 + 1] ?? 0, pos[vi * 3 + 2] ?? 0);
        normals.push(nx, ny, nz);
      }
      indices.push(found.index);
    }
  }
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
  };
}
