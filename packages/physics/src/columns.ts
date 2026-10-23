/**
 * Column representation of a solid: the occupied intervals along +Y (up) for every (x, z) cell of a regular grid.
 * Gravity points along -Y, so "what is under this point" is a column lookup, which is all a settle (a drop
 * until the first contact) needs. A column is built by casting a vertical ray through every triangle and
 * accumulating the winding number of the crossings, so overlapping shells and shared edges are harmless.
 */
import type { Mat3, Vec3 } from '@hsw-editor/compat';

/** Flat xyz mm and triangle corner indices, counter-clockwise seen from outside. */
export interface TriMesh {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

export interface ColumnGrid {
  cellMm: number;
  /** Global cell index of column (0, 0): cell i covers x in [i * cellMm, (i + 1) * cellMm). */
  i0: number;
  j0: number;
  nx: number;
  nz: number;
  /** Column c = (j - j0) * nx + (i - i0) owns `spans[2 * offsets[c] .. 2 * offsets[c + 1])` as [bottom, top] pairs. */
  offsets: Int32Array;
  spans: Float32Array;
  /** Bounds of the transformed mesh. */
  min: Vec3;
  max: Vec3;
}

/** The ray is nudged off the grid lines so that a shared edge is never hit twice (or not at all). */
const JITTER_X = 1.3e-4;
const JITTER_Z = 0.7e-4;

export function transformVertices(mesh: TriMesh, rotation: Mat3, translation: Vec3): Float64Array {
  const count = Math.floor(mesh.positions.length / 3);
  const out = new Float64Array(count * 3);
  for (let v = 0; v < count; v++) {
    const x = mesh.positions[3 * v] ?? 0;
    const y = mesh.positions[3 * v + 1] ?? 0;
    const z = mesh.positions[3 * v + 2] ?? 0;
    out[3 * v] = rotation[0] * x + rotation[1] * y + rotation[2] * z + translation[0];
    out[3 * v + 1] = rotation[3] * x + rotation[4] * y + rotation[5] * z + translation[1];
    out[3 * v + 2] = rotation[6] * x + rotation[7] * y + rotation[8] * z + translation[2];
  }
  return out;
}

export function boundsOfVertices(vertices: Float64Array): { min: Vec3; max: Vec3 } {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let v = 0; v < vertices.length; v += 3) {
    const x = vertices[v] ?? 0;
    const y = vertices[v + 1] ?? 0;
    const z = vertices[v + 2] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function emptyGrid(cellMm: number): ColumnGrid {
  return {
    cellMm,
    i0: 0,
    j0: 0,
    nx: 0,
    nz: 0,
    offsets: new Int32Array(1),
    spans: new Float32Array(0),
    min: [0, 0, 0],
    max: [0, 0, 0],
  };
}

/** Rasterises `mesh` (after `rotation` and `translation`) into columns. An empty mesh gives an empty grid. */
export function rasterize(
  mesh: TriMesh,
  rotation: Mat3,
  translation: Vec3,
  cellMm: number,
): ColumnGrid {
  const vertices = transformVertices(mesh, rotation, translation);
  if (vertices.length === 0 || mesh.indices.length === 0) return emptyGrid(cellMm);
  const { min, max } = boundsOfVertices(vertices);
  const i0 = Math.floor(min[0] / cellMm);
  const j0 = Math.floor(min[2] / cellMm);
  const nx = Math.max(1, Math.floor(max[0] / cellMm) - i0 + 1);
  const nz = Math.max(1, Math.floor(max[2] / cellMm) - j0 + 1);

  const columnOf: number[] = [];
  const heightOf: number[] = [];
  const windingOf: number[] = [];
  const idx = mesh.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = (idx[t] ?? 0) * 3;
    const b = (idx[t + 1] ?? 0) * 3;
    const c = (idx[t + 2] ?? 0) * 3;
    const ax = vertices[a] ?? 0;
    const ay = vertices[a + 1] ?? 0;
    const az = vertices[a + 2] ?? 0;
    const bx = vertices[b] ?? 0;
    const by = vertices[b + 1] ?? 0;
    const bz = vertices[b + 2] ?? 0;
    const cx = vertices[c] ?? 0;
    const cy = vertices[c + 1] ?? 0;
    const cz = vertices[c + 2] ?? 0;
    // y component of the face normal: > 0 means a +Y ray leaves the solid here.
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (Math.abs(ny) < 1e-12) continue;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    const minI = Math.floor(Math.min(ax, bx, cx) / cellMm);
    const maxI = Math.floor(Math.max(ax, bx, cx) / cellMm);
    const minJ = Math.floor(Math.min(az, bz, cz) / cellMm);
    const maxJ = Math.floor(Math.max(az, bz, cz) / cellMm);
    for (let j = minJ; j <= maxJ; j++) {
      const pz = (j + 0.5) * cellMm + JITTER_Z;
      for (let i = minI; i <= maxI; i++) {
        const px = (i + 0.5) * cellMm + JITTER_X;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
        const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        columnOf.push((j - j0) * nx + (i - i0));
        heightOf.push(l1 * ay + l2 * by + l3 * cy);
        windingOf.push(ny > 0 ? -1 : 1);
      }
    }
  }
  return buildSpans(cellMm, i0, j0, nx, nz, min, max, columnOf, heightOf, windingOf);
}

function buildSpans(
  cellMm: number,
  i0: number,
  j0: number,
  nx: number,
  nz: number,
  min: Vec3,
  max: Vec3,
  columnOf: readonly number[],
  heightOf: readonly number[],
  windingOf: readonly number[],
): ColumnGrid {
  const total = nx * nz;
  const starts = new Int32Array(total + 1);
  for (const column of columnOf) starts[column + 1] = (starts[column + 1] ?? 0) + 1;
  for (let c = 0; c < total; c++) starts[c + 1] = (starts[c + 1] ?? 0) + (starts[c] ?? 0);
  // Crossings grouped by column (counting sort), then ordered by height within each column (a few per column).
  const ys = new Float64Array(columnOf.length);
  const ws = new Int8Array(columnOf.length);
  const fill = starts.slice(0, total);
  for (let e = 0; e < columnOf.length; e++) {
    const column = columnOf[e] ?? 0;
    const at = fill[column] ?? 0;
    ys[at] = heightOf[e] ?? 0;
    ws[at] = windingOf[e] ?? 0;
    fill[column] = at + 1;
  }
  const offsets = new Int32Array(total + 1);
  const spans: number[] = [];
  for (let c = 0; c < total; c++) {
    const from = starts[c] ?? 0;
    const to = starts[c + 1] ?? 0;
    for (let k = from + 1; k < to; k++) {
      const y = ys[k] ?? 0;
      const w = ws[k] ?? 0;
      let m = k - 1;
      while (m >= from && (ys[m] ?? 0) > y) {
        ys[m + 1] = ys[m] ?? 0;
        ws[m + 1] = ws[m] ?? 0;
        m--;
      }
      ys[m + 1] = y;
      ws[m + 1] = w;
    }
    let winding = 0;
    let start = 0;
    const firstOfColumn = spans.length;
    for (let k = from; k < to; k++) {
      const before = winding;
      winding += ws[k] ?? 0;
      const y = ys[k] ?? 0;
      if (before <= 0 && winding > 0) start = y;
      else if (before > 0 && winding <= 0 && y > start) {
        const last = spans.length - 1;
        // Glue spans whose gap is float noise.
        if (last > firstOfColumn && start - (spans[last] ?? 0) < 1e-4) spans[last] = y;
        else spans.push(start, y);
      }
    }
    offsets[c + 1] = spans.length / 2;
  }
  return { cellMm, i0, j0, nx, nz, offsets, spans: Float32Array.from(spans), min, max };
}

/** Number of spans of the column at global cell (i, j); 0 outside the grid. */
export function spanRange(grid: ColumnGrid, i: number, j: number): readonly [number, number] {
  const di = i - grid.i0;
  const dj = j - grid.j0;
  if (di < 0 || dj < 0 || di >= grid.nx || dj >= grid.nz) return [0, 0];
  const c = dj * grid.nx + di;
  return [grid.offsets[c] ?? 0, grid.offsets[c + 1] ?? 0];
}

export function columnCount(grid: ColumnGrid): number {
  let n = 0;
  for (let c = 0; c < grid.nx * grid.nz; c++)
    if ((grid.offsets[c + 1] ?? 0) > (grid.offsets[c] ?? 0)) n++;
  return n;
}

/** Highest solid surface of the column at (i, j), or -Infinity when it is empty. */
export function topOf(grid: ColumnGrid, i: number, j: number): number {
  const [from, to] = spanRange(grid, i, j);
  return to > from ? (grid.spans[2 * to - 1] ?? -Infinity) : -Infinity;
}
