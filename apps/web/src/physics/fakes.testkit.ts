/** Closed solids and a fake worker environment for the physics tests: boxes, a slotted block, a bar tool. */
import type { ToolBody, TriMesh } from '@hsw-editor/physics';

type Vec3 = readonly [number, number, number];

/** Axis-aligned box as outward CCW triangles. */
function boxParts(min: Vec3, max: Vec3): { positions: number[]; indices: number[] } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: [
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
    ],
    indices: [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 6, 2, 3, 7, 6, 0, 4, 7, 0, 7, 3, 1,
      2, 6, 1, 6, 5,
    ],
  };
}

/** Several boxes as one triangle soup. */
export function boxes(...list: readonly (readonly [Vec3, Vec3])[]): TriMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [min, max] of list) {
    const part = boxParts(min, max);
    const base = positions.length / 3;
    positions.push(...part.positions);
    for (const i of part.indices) indices.push(i + base);
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

/** A block with a rectangular slot from above (x +-halfX, z 4..16) and a 4 mm floor: a bar dropped in stands in it. */
export function slotBlockMesh(halfX = 11, height = 40): TriMesh {
  return boxes(
    [
      [-halfX - 20, 0, 0],
      [-halfX, height, 20],
    ],
    [
      [halfX, 0, 0],
      [halfX + 20, height, 20],
    ],
    [
      [-halfX, 0, 0],
      [halfX, height, 4],
    ],
    [
      [-halfX, 0, 16],
      [halfX, height, 20],
    ],
    [
      [-halfX, 0, 4],
      [halfX, 4, 16],
    ],
  );
}

/** A plain bar: x +-10, y 0..200 (butt to tip), z +-5; centre of gravity at mid length. */
export function barTool(id = 'bar', massG = 100): ToolBody {
  return {
    id,
    mesh: boxes([
      [-10, 0, -5],
      [10, 200, 5],
    ]),
    massG,
    comMm: [0, 100, 0],
  };
}

export const ORIGIN = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 } as const;
