/**
 * What happens to a tool let go of with no mount: does it stay (something holds it, the same verdict as the hang badge) or
 * fall, and where it comes to rest. A falling tool tumbles into the axis-aligned pose with the lowest centre of gravity, keeps
 * its x and z (pushed forward only as far as the board and the floor's depth allow), and drops until the first thing it lands on;
 * where that thing cannot carry it (a holder's edge, another tool) it slides off towards the viewer and goes on to the floor.
 * Gravity points along `-Y`, the board is the plane `z = 0` (see `hang.ts`).
 */
import {
  apply,
  multiply,
  rotationX,
  rotationY,
  rotationZ,
  type Mat3,
  type Vec3,
} from '@hsw-editor/compat';
import { CELL_MM, centreOfGravity, type Placement, type SolidBody, type ToolBody } from './body.ts';
import { boundsOfVertices, type ColumnGrid, rasterize, transformVertices } from './columns.ts';
import type { NamedGrid } from './contacts.ts';
import {
  analyseHangPose,
  type HangOptions,
  type HangReason,
  type HangReport,
  nearbyObstacles,
} from './hang.ts';
import { scanAll } from './settle.ts';

/** Clearance (mm) a fallen tool keeps in front of the board plane. */
const BOARD_CLEARANCE_MM = 1;
/** How far (mm) a tool that cannot land on what is below it is pushed towards the viewer, in steps, to clear it. */
const SLIDE_STEP_MM = 10;
const SLIDE_LIMIT_MM = 400;
/** Orientations whose centre of gravity height differs by less than this (mm) are equally stable. */
const EQUAL_HEIGHT_MM = 0.5;
/** Interpenetration (mm) of the lying pose with an obstacle that is still a clear path (raster noise). */
const OVERLAP_OK_MM = 0.5;
/** A rest this close (mm) to the floor is on the floor. */
const FLOOR_EPS_MM = 0.25;

export interface FallInput {
  readonly tool: ToolBody;
  /** Where the tool is let go. */
  readonly placement: Placement;
  /** Everything it can touch: holders, board parts, other tools at their own poses. */
  readonly obstacles: readonly SolidBody[];
  /** Height (wall frame y, mm) of the floor plane. */
  readonly floorYMm: number;
  /** Depth (mm, from the board) the floor reaches towards the viewer; a fallen tool stays on it. */
  readonly floorDepthMm: number;
  readonly options?: Partial<HangOptions>;
}

export type FallPlan =
  /** Something holds the tool where it is: no fall. */
  | { readonly falls: false; readonly report: HangReport }
  | {
      readonly falls: true;
      /** The verdict at the release pose that sent it down. */
      readonly report: HangReport;
      /** The pose it comes to rest in. */
      readonly rest: Placement;
      /** Metres of fall as drawn: the drop of the centre of gravity (mm). */
      readonly dropMm: number;
      /** Id of the obstacle it lands on; null when it reaches the floor. */
      readonly landedOn: string | null;
    };

/** The verdicts of the hang badge that are errors about balance: nothing under the tool, or contacts that cannot stop it toppling. */
const FALLING_REASONS: ReadonlySet<HangReason['code']> = new Set<HangReason['code']>([
  'levitating',
  'falls',
  'tips',
]);

/**
 * A release falls when the hang analysis reports one of the balance errors (the same errors the physics badge shows in amber):
 * nothing carries the weight, or the contacts cannot keep it from toppling. Being sunk into a holder is no support: a tool let
 * go half inside one that also tips is pushed out and falls. A tool that only interpenetrates (it is held, the invalid zones
 * show the overlap), and one with only warnings (a swing, a slide under a bump, no pull-out retention), stay where they are.
 */
export function releaseFalls(report: HangReport): boolean {
  return report.reasons.some((r) => FALLING_REASONS.has(r.code));
}

/** The 24 axis-aligned orientations of a tool: each of its six faces up, four turns about the vertical each. */
export function axisAlignedRotations(): readonly Mat3[] {
  const faceUp = [
    rotationX(0),
    rotationX(180),
    rotationX(90),
    rotationX(270),
    rotationZ(90),
    rotationZ(270),
  ];
  return [0, 90, 180, 270].flatMap((turn) => faceUp.map((up) => multiply(rotationY(turn), up)));
}

interface Lying {
  readonly rotation: Mat3;
  /** Height of the centre of gravity over the lowest point of the tool. */
  readonly comHeightMm: number;
  /** The long axis of the tool lies along the wall's x axis. */
  readonly alongX: boolean;
  /** Closeness to the orientation at release (trace of `R0^T R`): breaks ties towards the least tumbling. */
  readonly nearness: number;
}

function lyingPoses(tool: ToolBody, from: Mat3): Lying[] {
  const poses: Lying[] = [];
  for (const rotation of axisAlignedRotations()) {
    const bounds = boundsOfVertices(transformVertices(tool.mesh, rotation, [0, 0, 0]));
    const com = apply(rotation, tool.comMm);
    const extent: Vec3 = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2],
    ];
    // The Frobenius product of the two rotations is trace(R0^T R): 3 when they are the same.
    const trace = from.reduce((sum, value, i) => sum + value * (rotation[i] ?? 0), 0);
    poses.push({
      rotation,
      comHeightMm: com[1] - bounds.min[1],
      alongX: extent[0] >= extent[1] && extent[0] >= extent[2],
      nearness: trace,
    });
  }
  return poses;
}

/** The pose the tool tumbles into: lowest centre of gravity, then lying along the wall (readable from the front), then the least turn. */
export function lyingRotation(tool: ToolBody, from: Mat3): Mat3 {
  const poses = lyingPoses(tool, from);
  const lowest = Math.min(...poses.map((p) => p.comHeightMm));
  const level = poses.filter((p) => p.comHeightMm <= lowest + EQUAL_HEIGHT_MM);
  const best = level.reduce((a, b) => {
    if (a.alongX !== b.alongX) return a.alongX ? a : b;
    return b.nearness > a.nearness ? b : a;
  });
  return best.rotation;
}

/** The hang analysis of the input's tool at `placement`, with the caller's options. */
function analyseAt(input: FallInput, placement: Placement): ReturnType<typeof analyseHangPose> {
  const { tool, obstacles, options } = input;
  return analyseHangPose({
    tool,
    placement,
    obstacles,
    ...(options === undefined ? {} : { options }),
  });
}

/** Decides what happens to `tool` released at `placement`. */
export function planFall(input: FallInput): FallPlan {
  const { tool, placement, obstacles, floorYMm, floorDepthMm } = input;
  const report = analyseAt(input, placement);
  if (!releaseFalls(report)) return { falls: false, report };

  const rotation = lyingRotation(tool, placement.rotation);
  const com = centreOfGravity(tool, placement);
  const turnedCom = apply(rotation, tool.comMm);
  const bounds = boundsOfVertices(transformVertices(tool.mesh, rotation, [0, 0, 0]));
  // x and z of the centre of gravity stay; the tool is kept in front of the board and on the floor.
  const minZ = BOARD_CLEARANCE_MM - bounds.min[2];
  const maxZ = floorDepthMm - bounds.max[2];
  const z0 = Math.min(Math.max(com[2] - turnedCom[2], minZ), Math.max(minZ, maxZ));
  const x = com[0] - turnedCom[0];
  const floorY = floorYMm - bounds.min[1];
  // The centre of gravity starts at its release height (never below the floor).
  const startY = Math.max(com[1] - turnedCom[1], floorY);
  const zMax = Math.max(minZ, maxZ);

  const near = nearbyObstacles(
    {
      min: [x + bounds.min[0], floorY + bounds.min[1], z0 + bounds.min[2]],
      max: [x + bounds.max[0], startY + bounds.max[1], zMax + bounds.max[2]],
    },
    obstacles,
    0,
  );
  const rest = slideToRest(input, rotation, near, { x, startY, floorY, z0, zMax });
  // Nowhere to lie without going through something: it stays where it was released.
  if (rest === null) return { falls: false, report };
  const placed = rest.placement ?? { rotation, position: [x, rest.y, rest.z] satisfies Vec3 };
  return {
    falls: true,
    report,
    rest: placed,
    dropMm: com[1] - centreOfGravity(tool, placed)[1],
    landedOn: rest.onFloor ? null : (landedOnId(near, tool, placed) ?? null),
  };
}

interface Descent {
  readonly x: number;
  readonly startY: number;
  readonly floorY: number;
  readonly z0: number;
  readonly zMax: number;
}

/** A resting place; `placement` is set when the balance needs the lean the hang analysis found (it replaces the plain lying pose). */
type Rest = { y: number; z: number; onFloor: boolean; placement?: Placement };

/**
 * Where the tumbled tool comes to rest: on the first thing it balances on, else on the floor, else where it first landed.
 * Sliding towards the viewer on the cheap column scans finds the first contact and the floor; the costly hang analysis runs
 * once, at the first contact.
 */
function slideToRest(
  input: FallInput,
  rotation: Mat3,
  near: readonly NamedGrid[],
  { x, startY, floorY, z0, zMax }: Descent,
): Rest | null {
  const grids = near.map((o) => o.grid);
  let firstHit: { y: number; z: number } | null = null;
  let onFloor: Rest | null = null;
  for (let slide = 0; slide <= SLIDE_LIMIT_MM && onFloor === null; slide += SLIDE_STEP_MM) {
    const z = Math.min(z0 + slide, zMax);
    const { grid, di, dj } = columnsAt(input.tool, rotation, [x, startY, z]);
    const scan = scanAll(grid, grids, di, dj, startY, 1, -Infinity, grids.length);
    // Tumbling into the lying pose would sweep through something here: it goes down further out.
    if (scan.penetrationMm <= OVERLAP_OK_MM) {
      const restY = Math.max(startY - scan.fallMm, floorY);
      if (restY <= floorY + FLOOR_EPS_MM) onFloor = { y: floorY, z, onFloor: true };
      else firstHit ??= { y: restY, z };
    }
    // The depth of the floor is spent: sliding further towards the viewer cannot clear anything.
    if (z >= zMax) break;
  }
  return chooseRest(input, rotation, x, firstHit, onFloor);
}

/** Stay on the first contact when it balances (with its lean), else the floor, else the first contact; null when none. */
function chooseRest(
  input: FallInput,
  rotation: Mat3,
  x: number,
  firstHit: { y: number; z: number } | null,
  onFloor: Rest | null,
): Rest | null {
  if (firstHit === null) return onFloor;
  const lying = analyseAt(input, { rotation, position: [x, firstHit.y, firstHit.z] });
  if (releaseFalls(lying)) return onFloor ?? { ...firstHit, onFloor: false };
  const lean = lying.rest?.placement;
  return { ...firstHit, onFloor: false, ...(lean === undefined ? {} : { placement: lean }) };
}

/** The tool's columns at `position`, with the whole-cell shift the scans take; the sub-cell part stays in the raster. */
function columnsAt(
  tool: ToolBody,
  rotation: Mat3,
  position: Vec3,
): { grid: ColumnGrid; di: number; dj: number } {
  const di = Math.round(position[0] / CELL_MM);
  const dj = Math.round(position[2] / CELL_MM);
  const grid = rasterize(
    tool.mesh,
    rotation,
    [position[0] - di * CELL_MM, 0, position[2] - dj * CELL_MM],
    CELL_MM,
  );
  return { grid, di, dj };
}

/** Id of the obstacle the tool rests on at `placement` (the one it touches); undefined when it rests on none. */
function landedOnId(
  near: readonly NamedGrid[],
  tool: ToolBody,
  placement: Placement,
): string | undefined {
  const { grid, di, dj } = columnsAt(tool, placement.rotation, placement.position);
  let best: { id: string; fallMm: number } | undefined;
  for (const candidate of near) {
    const { fallMm } = scanAll(
      grid,
      [candidate.grid],
      di,
      dj,
      placement.position[1],
      1,
      -Infinity,
      0,
    );
    if (best === undefined || fallMm < best.fallMm) best = { id: candidate.id, fallMm };
  }
  return best !== undefined && best.fallMm < 1 ? best.id : undefined;
}
