import type { BankElement, CellOffset } from '@hsw-editor/bank';
import { cellInBoard, type Board, type GridCell, type WallItem } from '@hsw-editor/core';

/** `col,row` key used for occupancy sets. */
export function cellKey(cell: GridCell): string {
  return `${cell.col},${cell.row}`;
}

/** Half-row coordinate: neighbouring columns are staggered by half a row, so y2 = 2 * row + (col & 1). */
function toHalfRows(cell: GridCell): number {
  return 2 * cell.row + (cell.col & 1);
}

/** Cell reached from `anchor` by `offset` (bank convention: dCol columns, dRow2 half-rows). */
export function offsetCell(anchor: GridCell, offset: CellOffset): GridCell {
  const col = anchor.col + offset.dCol;
  const y2 = toHalfRows(anchor) + offset.dRow2;
  return { col, row: Math.floor((y2 - (col & 1)) / 2) };
}

/**
 * Rotates a cell offset about the anchor by a multiple of 60 degrees. The lattice is a regular
 * hexagonal one (neighbours equidistant), so the rotated offset is again exactly a lattice offset;
 * other angles are rounded to the nearest lattice offset.
 */
export function rotateOffset(offset: CellOffset, rotZDeg: number, board: Board): CellOffset {
  const angle = (rotZDeg * Math.PI) / 180;
  const x = offset.dCol * board.colPitchMm;
  const y = (offset.dRow2 * board.rowPitchMm) / 2;
  const rx = x * Math.cos(angle) - y * Math.sin(angle);
  const ry = x * Math.sin(angle) + y * Math.cos(angle);
  // `|| 0` turns -0 into 0 so offsets compare equal.
  const dCol = Math.round(rx / board.colPitchMm) || 0;
  let dRow2 = Math.round((2 * ry) / board.rowPitchMm) || 0;
  if ((dRow2 - dCol) % 2 !== 0) {
    // Not on the lattice: pick the nearer of the two parity-correct half-rows.
    const lower = dRow2 - 1;
    const upper = dRow2 + 1;
    dRow2 =
      Math.abs((2 * ry) / board.rowPitchMm - lower) <= Math.abs((2 * ry) / board.rowPitchMm - upper)
        ? lower
        : upper;
  }
  return { dCol, dRow2: dRow2 || 0 };
}

/** Cells covered by `element` placed with its anchor on `anchor`, rotated by `rotZDeg`. */
export function footprintCells(
  element: BankElement,
  anchor: GridCell,
  rotZDeg: number,
  board: Board,
): GridCell[] {
  return element.footprint.cells.map((offset) =>
    offsetCell(anchor, rotateOffset(offset, rotZDeg, board)),
  );
}

export type LayoutProblem = 'collision' | 'bounds';

/**
 * Footprint-aware layout check (the core only knows anchors): items whose footprints overlap, and
 * items with a footprint cell off the board. Free-placed items (no cell) are not checked.
 */
export function layoutProblems(
  items: readonly WallItem[],
  board: Board,
  bank: ReadonlyMap<string, BankElement>,
): ReadonlyMap<string, LayoutProblem> {
  const problems = new Map<string, LayoutProblem>();
  const owner = new Map<string, string>();
  for (const item of items) {
    if (item.cell === undefined || item.bankId === undefined || item.kind === 'photo-ref') continue;
    const element = bank.get(item.bankId);
    if (!element) continue;
    for (const cell of footprintCells(element, item.cell, item.pose.rotZ, board)) {
      if (!cellInBoard(board, cell)) {
        problems.set(item.id, 'bounds');
        continue;
      }
      const key = cellKey(cell);
      const other = owner.get(key);
      if (other !== undefined && other !== item.id) {
        problems.set(item.id, 'collision');
        problems.set(other, 'collision');
      } else {
        owner.set(key, item.id);
      }
    }
  }
  return problems;
}

/** Every cell covered by some item, for the occupied-cell tint of the board. */
export function occupiedCells(
  items: readonly WallItem[],
  board: Board,
  bank: ReadonlyMap<string, BankElement>,
): Set<string> {
  const cells = new Set<string>();
  for (const item of items) {
    if (item.cell === undefined || item.bankId === undefined) continue;
    const element = bank.get(item.bankId);
    if (!element) continue;
    for (const cell of footprintCells(element, item.cell, item.pose.rotZ, board)) {
      cells.add(cellKey(cell));
    }
  }
  return cells;
}
