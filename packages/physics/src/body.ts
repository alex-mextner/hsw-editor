/**
 * Posed solids of a scene (holders, neighbouring tools, shelves) with lazily computed bounds and column grids,
 * and the tool as a rigid body (mesh, mass, centre of gravity in the tool frame).
 */
import {
  apply,
  eulerToMatrix,
  type Mat3,
  multiply,
  rotationY,
  rotationZ,
  type Vec3,
} from '@hsw-editor/compat';
import {
  boundsOfVertices,
  type ColumnGrid,
  rasterize,
  transformVertices,
  type TriMesh,
} from './columns.ts';

/** Column size of every raster (mm): a 4 mm shaft in a 5 mm hole is still 8 vs 10 cells. */
export const CELL_MM = 0.5;

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export class SolidBody {
  private cachedBounds: Bounds | null = null;
  private readonly grids = new Map<number, ColumnGrid>();

  constructor(
    readonly id: string,
    readonly mesh: TriMesh,
    readonly rotation: Mat3,
    readonly translation: Vec3,
  ) {}

  bounds(): Bounds {
    this.cachedBounds ??= boundsOfVertices(
      transformVertices(this.mesh, this.rotation, this.translation),
    );
    return this.cachedBounds;
  }

  grid(cellMm: number = CELL_MM): ColumnGrid {
    let grid = this.grids.get(cellMm);
    if (grid === undefined) {
      grid = rasterize(this.mesh, this.rotation, this.translation, cellMm);
      this.grids.set(cellMm, grid);
    }
    return grid;
  }
}

export interface ToolBody {
  id: string;
  /** Mesh in the tool frame (origin on the axis at the butt, +Y towards the working end), mm. */
  mesh: TriMesh;
  massG: number;
  /** Centre of gravity in the tool frame, mm. */
  comMm: Vec3;
  /** Where the tool hangs from a peg or hook, when it has a hole, a loop or a neck for it (tool frame, mm). */
  hang?: { point: Vec3; kind: string; diameterMm?: number | undefined } | undefined;
}

/** Pose of a tool: `world = rotation * p + position`. */
export interface Placement {
  rotation: Mat3;
  position: Vec3;
}

export function placementOfPose(pose: {
  x: number;
  y: number;
  z: number;
  rotX: number;
  rotY: number;
  rotZ: number;
}): Placement {
  return { rotation: eulerToMatrix(pose), position: [pose.x, pose.y, pose.z] };
}

export function centreOfGravity(tool: ToolBody, placement: Placement): Vec3 {
  const r = apply(placement.rotation, tool.comMm);
  return [r[0] + placement.position[0], r[1] + placement.position[1], r[2] + placement.position[2]];
}

/** Quarter turns of the tool about its own axis, then the in-plane flip: the four orientations of a slot insertion. */
export function turnedAboutAxis(quarterTurns: number, upsideDown: boolean): Mat3 {
  const flip = rotationZ(upsideDown ? 180 : 0);
  return multiply(rotationY(90 * quarterTurns), flip);
}

export function worldBounds(tool: ToolBody, placement: Placement): Bounds {
  return boundsOfVertices(transformVertices(tool.mesh, placement.rotation, placement.position));
}

export function boundsOverlap(a: Bounds, b: Bounds, marginMm: number): boolean {
  return (
    a.min[0] - marginMm <= b.max[0] &&
    a.max[0] + marginMm >= b.min[0] &&
    a.min[1] - marginMm <= b.max[1] &&
    a.max[1] + marginMm >= b.min[1] &&
    a.min[2] - marginMm <= b.max[2] &&
    a.max[2] + marginMm >= b.min[2]
  );
}
