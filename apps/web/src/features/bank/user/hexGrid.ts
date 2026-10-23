/**
 * Honeycomb geometry of the footprint / mounting pickers. Pure: the SVG grid and the 3D preview overlay both
 * read it, and the tests need no DOM. Cells are offsets from the anchor cell (docs/bank.md): `dCol` columns to
 * the right, `dRow2` HALF-rows up, `dRow2 ≡ dCol (mod 2)`.
 */
import { HSW_COL_PITCH_MM, HSW_ROW_PITCH_MM } from '@hsw-editor/core';
import type { BboxMm, CellOffset, Vec3 } from '@hsw-editor/bank';

/** Every neighbour is `HSW_ROW_PITCH_MM` away, so the regular hexagon around a cell has this circumradius. */
export const CELL_RADIUS_MM = HSW_ROW_PITCH_MM / Math.sqrt(3);

export const ANCHOR_CELL: CellOffset = { dCol: 0, dRow2: 0 };

export interface PointMm {
  readonly x: number;
  readonly y: number;
}

export function cellKey(cell: CellOffset): string {
  return `${cell.dCol}_${cell.dRow2}`;
}

export function sameCell(a: CellOffset, b: CellOffset): boolean {
  return a.dCol === b.dCol && a.dRow2 === b.dRow2;
}

export function isAnchor(cell: CellOffset): boolean {
  return sameCell(cell, ANCHOR_CELL);
}

export function hasCell(cells: readonly CellOffset[], cell: CellOffset): boolean {
  return cells.some((candidate) => sameCell(candidate, cell));
}

/** Wall-frame centre (mm, y up) of a cell. */
export function cellCentreMm(cell: CellOffset): PointMm {
  return { x: cell.dCol * HSW_COL_PITCH_MM, y: (cell.dRow2 * HSW_ROW_PITCH_MM) / 2 };
}

/** Corners of a flat-sided hexagon around `centre` (a vertex points along +x, matching the lattice). */
export function hexCorners(centre: PointMm, radius: number): readonly PointMm[] {
  return Array.from({ length: 6 }, (_, corner) => {
    const angle = (corner * Math.PI) / 3;
    return { x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) };
  });
}

/**
 * Footprint size the way `packages/bank/src/validate.ts` derives it; the server rejects an element whose stored
 * numbers disagree, so the formulas must stay identical.
 */
export function footprintDims(cells: readonly CellOffset[]): { cols: number; rows: number } {
  if (cells.length === 0) return { cols: 0, rows: 0 };
  const dCols = cells.map((cell) => cell.dCol);
  const dRows = cells.map((cell) => cell.dRow2);
  return {
    cols: Math.max(...dCols) - Math.min(...dCols) + 1,
    rows: Math.ceil((Math.max(...dRows) - Math.min(...dRows)) / 2) + 1,
  };
}

export interface CellWindow {
  readonly minCol: number;
  readonly maxCol: number;
  readonly minRow2: number;
  readonly maxRow2: number;
}

/** Extra columns / half-rows shown around the footprint on every side, so a cell can be added next to it. */
export const WINDOW_MARGIN = 2;

export function cellWindow(
  cells: readonly CellOffset[],
  margin: number = WINDOW_MARGIN,
): CellWindow {
  const all = [ANCHOR_CELL, ...cells];
  const dCols = all.map((cell) => cell.dCol);
  const dRows = all.map((cell) => cell.dRow2);
  return {
    minCol: Math.min(...dCols) - margin,
    maxCol: Math.max(...dCols) + margin,
    minRow2: Math.min(...dRows) - margin,
    maxRow2: Math.max(...dRows) + margin,
  };
}

/** Every valid lattice cell inside the window (parity rule), top row first, left to right. */
export function windowCells(window: CellWindow): CellOffset[] {
  const out: CellOffset[] = [];
  for (let dRow2 = window.maxRow2; dRow2 >= window.minRow2; dRow2 -= 1) {
    for (let dCol = window.minCol; dCol <= window.maxCol; dCol += 1) {
      if ((((dRow2 - dCol) % 2) + 2) % 2 === 0) out.push({ dCol, dRow2 });
    }
  }
  return out;
}

/**
 * Two corner offsets (not necessarily lattice cells) that bound the model's silhouette on the wall. Passed as
 * extra `extent` they make the editor window cover the whole model from the start, so cells do not rescale
 * under the pointer while the footprint is painted.
 */
export function boxExtent(bbox: BboxMm): CellOffset[] {
  const half = HSW_ROW_PITCH_MM / 2;
  return [
    { dCol: Math.floor(bbox.min.x / HSW_COL_PITCH_MM), dRow2: Math.floor(bbox.min.y / half) },
    { dCol: Math.ceil(bbox.max.x / HSW_COL_PITCH_MM), dRow2: Math.ceil(bbox.max.y / half) },
  ];
}

export interface ViewBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** SVG viewBox (y down, so y is negated) enclosing every cell of the window. */
export function windowViewBox(window: CellWindow): ViewBox {
  const left = window.minCol * HSW_COL_PITCH_MM - CELL_RADIUS_MM;
  const right = window.maxCol * HSW_COL_PITCH_MM + CELL_RADIUS_MM;
  const top = (window.maxRow2 * HSW_ROW_PITCH_MM) / 2 + HSW_ROW_PITCH_MM / 2;
  const bottom = (window.minRow2 * HSW_ROW_PITCH_MM) / 2 - HSW_ROW_PITCH_MM / 2;
  return { x: left, y: -top, width: right - left, height: top - bottom };
}

/** SVG `points` attribute of a cell hexagon (y flipped to the SVG's downwards axis). */
export function hexSvgPoints(cell: CellOffset, radius: number = CELL_RADIUS_MM): string {
  return hexCorners(cellCentreMm(cell), radius)
    .map((corner) => `${corner.x.toFixed(2)},${(-corner.y).toFixed(2)}`)
    .join(' ');
}

/** Bounding box that also encloses the hexagons of `cells` on the wall plane z = 0, so the preview camera frames both. */
export function boxWithCells(
  bbox: BboxMm,
  cells: readonly CellOffset[],
): { bbox: BboxMm; dims: Vec3 } {
  let { min, max } = bbox;
  for (const cell of cells) {
    const centre = cellCentreMm(cell);
    min = {
      x: Math.min(min.x, centre.x - CELL_RADIUS_MM),
      y: Math.min(min.y, centre.y - HSW_ROW_PITCH_MM / 2),
      z: Math.min(min.z, 0),
    };
    max = {
      x: Math.max(max.x, centre.x + CELL_RADIUS_MM),
      y: Math.max(max.y, centre.y + HSW_ROW_PITCH_MM / 2),
      z: Math.max(max.z, 0),
    };
  }
  return {
    bbox: { min, max },
    dims: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
  };
}
