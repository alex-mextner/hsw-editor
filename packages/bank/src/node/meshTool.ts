/** JSON contract of scripts/bank/py/mesh_tool.py. */

export type SignedAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export interface Orientation {
  /** Source axis that points away from the wall. */
  out: SignedAxis;
  /** Source axis that points up on the wall. */
  up: SignedAxis;
}

export interface ProbePart {
  partId: string;
  triangles: number;
  bboxMm: [[number, number, number], [number, number, number]];
  geometryHash: string;
  watertight: boolean;
  sortedDimsMm: [number, number, number];
  volumeMm3: number;
  areaMm2: number;
  guess: Orientation & { wallFaceAreaMm2: number };
}

export interface ProbeFile {
  path: string;
  sha256: string;
  parts: ProbePart[];
  error: string | null;
  /** Metadata embedded in 3MF files (Title, Designer, License, SourceLink, ...). */
  meta: Record<string, string>;
}

export interface ProbeResult {
  toolVersion: number;
  files: ProbeFile[];
}

export type AnchorMode = 'origin' | 'back-bbox' | 'panel';

export interface BuildItem {
  key: string;
  path: string;
  partId: string;
  orient: Orientation;
  anchor: AnchorMode;
  /** Thickness of the wall-facing slab whose silhouette defines the footprint. */
  backSlabMm: number;
  glb: string;
  thumbnail: string;
  views: string[];
  color: string;
}

export interface BuildItemResult {
  key: string;
  ok: boolean;
  error: string | null;
  bboxMm?: { min: [number, number, number]; max: [number, number, number] };
  triangles?: number;
  cells?: [number, number][];
  watertight?: boolean;
  anchorSourceMm?: [number, number];
}

export interface BuildResult {
  toolVersion: number;
  items: BuildItemResult[];
}
