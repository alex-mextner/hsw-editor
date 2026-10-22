/** Versioned wall document. All lengths are millimetres, Z up, wall plane = XZ at y = 0. */
export const WALL_SCHEMA_VERSION = 1 as const;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Honeycomb grid of the HSW panel the wall is built on. */
export interface HoneycombGrid {
  /** Distance between neighbouring cell centres. */
  readonly pitchMm: number;
}

/** One placed element: an HSW holder from the bank (`bankId`) or a tool model. */
export interface WallElement {
  readonly id: string;
  readonly bankId: string;
  readonly position: Vec3;
  /** Rotation about the wall normal, in degrees, snapped to the honeycomb symmetry (60). */
  readonly rotationDeg: number;
}

export interface Wall {
  readonly schemaVersion: typeof WALL_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly grid: HoneycombGrid;
  readonly elements: readonly WallElement[];
}

export const DEFAULT_GRID_PITCH_MM = 25;

export function createEmptyWall(id: string, name: string, widthMm = 1200, heightMm = 800): Wall {
  return {
    schemaVersion: WALL_SCHEMA_VERSION,
    id,
    name,
    widthMm,
    heightMm,
    grid: { pitchMm: DEFAULT_GRID_PITCH_MM },
    elements: [],
  };
}

/** Returns human-readable problems; an empty array means the wall is valid. */
export function validateWall(wall: Wall): string[] {
  const problems: string[] = [];
  const positive = (value: number): boolean => Number.isFinite(value) && value > 0;
  if (!positive(wall.widthMm) || !positive(wall.heightMm)) {
    problems.push('wall size must be positive');
  }
  if (!positive(wall.grid.pitchMm)) problems.push('grid pitch must be positive');
  const seen = new Set<string>();
  for (const element of wall.elements) {
    if (seen.has(element.id)) problems.push(`duplicate element id ${element.id}`);
    seen.add(element.id);
    const { x, z } = element.position;
    if (!Number.isFinite(x) || x < 0 || x > wall.widthMm) {
      problems.push(`element ${element.id} is outside the wall horizontally`);
    }
    if (!Number.isFinite(z) || z < 0 || z > wall.heightMm) {
      problems.push(`element ${element.id} is outside the wall vertically`);
    }
  }
  return problems;
}
