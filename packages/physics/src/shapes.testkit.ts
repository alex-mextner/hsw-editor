/** Closed test solids (outward CCW triangles) for the physics tests: boxes, rods along Z, and unions of them. */
import type { Mat3 } from '@hsw-editor/compat';
import { SolidBody, type ToolBody } from './body.ts';
import type { TriMesh } from './columns.ts';

export interface MutableMesh {
  positions: number[];
  indices: number[];
}

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Axis-aligned box [min, max]. */
export function box(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): MutableMesh {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positions = [
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y1,
    z0,
    x0,
    y1,
    z0,
    x0,
    y0,
    z1,
    x1,
    y0,
    z1,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  ];
  const indices = [
    0,
    2,
    1,
    0,
    3,
    2, // -z
    4,
    5,
    6,
    4,
    6,
    7, // +z
    0,
    1,
    5,
    0,
    5,
    4, // -y
    3,
    6,
    2,
    3,
    7,
    6, // +y
    0,
    4,
    7,
    0,
    7,
    3, // -x
    1,
    2,
    6,
    1,
    6,
    5, // +x
  ];
  return { positions, indices };
}

/** Rod along Z through (cx, cy). */
export function rodZ(
  cx: number,
  cy: number,
  radius: number,
  z0: number,
  z1: number,
  segments = 24,
): MutableMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a), z0);
    positions.push(cx + radius * Math.cos(a), cy + radius * Math.sin(a), z1);
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(2 * i, 2 * j, 2 * j + 1, 2 * i, 2 * j + 1, 2 * i + 1);
  }
  const c0 = positions.length / 3;
  positions.push(cx, cy, z0, cx, cy, z1);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    indices.push(c0, 2 * j, 2 * i); // z0 cap faces -z
    indices.push(c0 + 1, 2 * i + 1, 2 * j + 1); // z1 cap faces +z
  }
  return { positions, indices };
}

/** Several overlapping or touching shells as one soup (the rasteriser and the booleans accept it). */
export function union(...parts: MutableMesh[]): TriMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    positions.push(...part.positions);
    for (const i of part.indices) indices.push(i + base);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A plain bar: x +-w/2, y 0..length (butt to tip), z +-t/2; centre of gravity at mid length. */
export function barTool(id = 'bar', length = 200, w = 20, t = 10, massG = 100): ToolBody {
  return {
    id,
    mesh: union(box([-w / 2, 0, -t / 2], [w / 2, length, t / 2])),
    massG,
    comMm: [0, length / 2, 0],
  };
}

export function solid(id: string, ...parts: MutableMesh[]): SolidBody {
  return new SolidBody(id, union(...parts), IDENTITY, [0, 0, 0]);
}

/** `body` moved by (x, y, z) in the wall frame. */
export function moved(body: SolidBody, x: number, y: number, z: number): SolidBody {
  return new SolidBody(body.id, body.mesh, body.rotation, [x, y, z]);
}

/** A block with a rectangular slot through it from above (x +-halfX, z from z0 to z1), floor `floorMm` thick (0 = through). */
export function slotBlock(
  id: string,
  opts: { halfX: number; z0: number; z1: number; height: number; floorMm?: number },
): SolidBody {
  const { halfX, z0, z1, height, floorMm = 0 } = opts;
  const parts = [
    box([-halfX - 20, 0, 0], [-halfX, height, z1 + 4]),
    box([halfX, 0, 0], [halfX + 20, height, z1 + 4]),
    box([-halfX, 0, 0], [halfX, height, z0]),
    box([-halfX, 0, z1], [halfX, height, z1 + 4]),
  ];
  if (floorMm > 0) parts.push(box([-halfX, 0, z0], [halfX, floorMm, z1]));
  return solid(id, ...parts);
}

/** Flat shelf: x from -halfX to halfX, top at `top`, depth `depth` from the wall. */
export function shelf(id: string, halfX: number, top: number, depth: number): SolidBody {
  return solid(
    id,
    box([-halfX, top - 4, 0], [halfX, top, depth]),
    box([-halfX, top - 40, 0], [halfX, top, 4]),
  );
}
