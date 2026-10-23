/** Assembly of index geometry fields from a mesh_tool build result; shared by ingest and the variant endpoint. */
import type { BankElement, CellOffset } from '../schema.ts';
import type { BuildItem, BuildItemResult } from './meshTool.ts';

/** Thickness of the wall-facing slab whose silhouette defines the footprint. */
export const BACK_SLAB_MM = 1;

const CATEGORY_COLORS: Record<string, string> = {
  holders: '#4f7fb0',
  hooks: '#c27a3a',
  bins: '#4f9a6b',
  shelves: '#8a6bb0',
  inserts: '#7d8793',
  accessories: '#3f9aa3',
  panels: '#a8b0ba',
};

/** Inputs of the mesh_tool build item that depend on the element rather than on the geometry. */
export function artefactInputs(
  category: string,
): Pick<BuildItem, 'backSlabMm' | 'views' | 'color'> {
  return {
    backSlabMm: BACK_SLAB_MM,
    views: ['iso'],
    color: CATEGORY_COLORS[category.split('/')[0] ?? ''] ?? '#4f7fb0',
  };
}

export interface BuiltGeometry {
  bboxMm: BankElement['bboxMm'];
  dimsMm: BankElement['dimsMm'];
  footprint: BankElement['footprint'];
  mountingCells: CellOffset[];
}

function toCells(pairs: readonly [number, number][]): CellOffset[] {
  return pairs.map(([dCol, dRow2]) => ({ dCol, dRow2 }));
}

/** Footprint record of a cell list: `cols`/`rows` derived the way `validateBankIndex` checks them. */
export function footprintOf(cells: readonly CellOffset[]): BankElement['footprint'] {
  const cols = cells.map((c) => c.dCol);
  const rows2 = cells.map((c) => c.dRow2);
  return {
    cells: [...cells],
    cols: Math.max(...cols) - Math.min(...cols) + 1,
    rows: Math.ceil((Math.max(...rows2) - Math.min(...rows2)) / 2) + 1,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Rounds to 1 µm, clamps the bottom to the wall plane (z >= 0) and derives dims, footprint and mounting cells. */
export function geometryOf(
  built: Pick<BuildItemResult, 'bboxMm' | 'cells' | 'mountingCells'>,
  mountKind: BankElement['mounting']['kind'],
): BuiltGeometry {
  const bbox = built.bboxMm;
  if (!bbox) throw new Error('build result has no bounding box');
  const cells = toCells(built.cells ?? [[0, 0]]);
  const mountingCells =
    mountKind === 'none'
      ? []
      : mountKind === 'm3-screw' && (built.mountingCells?.length ?? 0) > 0
        ? toCells(built.mountingCells ?? [])
        : cells;
  return {
    bboxMm: {
      min: { x: round3(bbox.min[0]), y: round3(bbox.min[1]), z: Math.max(0, round3(bbox.min[2])) },
      max: { x: round3(bbox.max[0]), y: round3(bbox.max[1]), z: round3(bbox.max[2]) },
    },
    dimsMm: {
      x: round3(bbox.max[0] - bbox.min[0]),
      y: round3(bbox.max[1] - bbox.min[1]),
      z: round3(bbox.max[2] - Math.max(0, bbox.min[2])),
    },
    footprint: footprintOf(cells),
    mountingCells,
  };
}
