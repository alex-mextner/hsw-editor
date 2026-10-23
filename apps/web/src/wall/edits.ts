/** Builders for the ops the editor sends, plus placement search on the honeycomb lattice. */
import type { BankElement, CellOffset } from '@hsw-editor/bank';
import {
  cellCenter,
  newId,
  type Board,
  type GridCell,
  type LeafOp,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { layoutProblems, offsetCell } from './footprint.ts';

export type BankLookup = ReadonlyMap<string, BankElement>;

/** Item kind for a bank element: panels are board parts, everything else a holder. */
export function itemKindFor(element: BankElement): WallItem['kind'] {
  return element.category === 'panels' ? 'board-part' : 'holder';
}

export function newItem(element: BankElement, cell: GridCell, board: Board, rotZ = 0): WallItem {
  const centre = cellCenter(board, cell);
  return {
    id: newId('i'),
    kind: itemKindFor(element),
    bankId: element.id,
    cell,
    pose: { x: centre.x, y: centre.y, z: 0, rotX: 0, rotY: 0, rotZ },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

export function addItemOp(item: WallItem): LeafOp {
  return { type: 'addItem', item };
}

/** True if `item` (a candidate) fits on the board without touching any other item's footprint. */
export function fitsAt(wall: Wall, bank: BankLookup, candidate: WallItem): boolean {
  const next = [...wall.items.filter((item) => item.id !== candidate.id), candidate];
  const problems = layoutProblems(next, wall.board, bank);
  return !problems.has(candidate.id);
}

/**
 * Nearest free cell to `near` (ring search outwards over the lattice) where `element` fits, or null
 * if the board is full. Ring order is by lattice distance so the first hit is the closest.
 */
export function findFreeCell(
  wall: Wall,
  bank: BankLookup,
  element: BankElement,
  near: GridCell,
  rotZ = 0,
): GridCell | null {
  // Staggered lattice: opposite corners are up to cols + rows rings apart.
  const maxRing = wall.board.cols + wall.board.rows;
  const seen = new Set<string>();
  for (let ring = 0; ring <= maxRing; ring += 1) {
    const candidates = ring === 0 ? [near] : ringCells(near, ring);
    for (const cell of candidates) {
      const key = `${cell.col},${cell.row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        cell.col < 0 ||
        cell.row < 0 ||
        cell.col >= wall.board.cols ||
        cell.row >= wall.board.rows
      ) {
        continue;
      }
      if (fitsAt(wall, bank, newItem(element, cell, wall.board, rotZ))) return cell;
    }
  }
  return null;
}

/** Cells at hex distance exactly `ring` from `centre` (walk the six sides of the hexagon). */
export function ringCells(centre: GridCell, ring: number): GridCell[] {
  const directions = [
    { dCol: 1, dRow2: 1 },
    { dCol: 0, dRow2: 2 },
    { dCol: -1, dRow2: 1 },
    { dCol: -1, dRow2: -1 },
    { dCol: 0, dRow2: -2 },
    { dCol: 1, dRow2: -1 },
  ];
  const first = directions[4];
  if (!first) return [];
  // Start `ring` steps along direction 4 (down), then walk the sides counter-clockwise.
  let cell = centre;
  for (let step = 0; step < ring; step += 1) cell = offsetCell(cell, first);
  const cells: GridCell[] = [];
  for (const direction of directions.slice(0, 6)) {
    for (let step = 0; step < ring; step += 1) {
      cells.push(cell);
      cell = offsetCell(cell, direction);
    }
  }
  return cells;
}

/** The zero shift followed by every lattice offset within `maxRing` rings, nearest first. */
function ringShifts(maxRing: number): CellOffset[] {
  const shifts: CellOffset[] = [{ dCol: 0, dRow2: 0 }];
  for (let ring = 1; ring <= maxRing; ring += 1) {
    for (const cell of ringCells({ col: 0, row: 0 }, ring)) {
      shifts.push({ dCol: cell.col, dRow2: 2 * cell.row + (cell.col & 1) });
    }
  }
  return shifts;
}

/** Copies of `items` all land on free cells and nowhere else: none overlaps anything or leaves the board. */
function copiesFit(wall: Wall, bank: BankLookup, copies: readonly WallItem[]): boolean {
  const problems = layoutProblems([...wall.items, ...copies], wall.board, bank);
  return copies.every((copy) => !problems.has(copy.id));
}

/** Copies of `items` shifted together by the smallest lattice offset where all of them fit. */
export function duplicateOps(wall: Wall, bank: BankLookup, items: readonly WallItem[]): LeafOp[] {
  const anchored = items.filter((item) => item.cell !== undefined);
  if (!anchored[0]?.cell) return [];
  for (const shift of ringShifts(12).slice(1)) {
    const copies = anchored.map((item) => copyShifted(item, shift, wall.board));
    if (copiesFit(wall, bank, copies)) return copies.map((copy) => addItemOp(copy));
  }
  return [];
}

/**
 * Copies of `items` with the first one on `target` and the rest keeping their layout around it. When
 * that spot is taken, the whole group moves to the nearest lattice offset where everything fits.
 */
export function pasteOps(
  wall: Wall,
  bank: BankLookup,
  items: readonly WallItem[],
  target: GridCell,
): LeafOp[] {
  const anchored = items.filter((item) => item.cell !== undefined);
  const first = anchored[0]?.cell;
  if (!first) return [];
  const halfRows = (cell: GridCell): number => 2 * cell.row + (cell.col & 1);
  const base = { dCol: target.col - first.col, dRow2: halfRows(target) - halfRows(first) };
  for (const extra of ringShifts(12)) {
    const shift = { dCol: base.dCol + extra.dCol, dRow2: base.dRow2 + extra.dRow2 };
    const copies = anchored.map((item) => copyShifted(item, shift, wall.board));
    if (copiesFit(wall, bank, copies)) return copies.map((copy) => addItemOp(copy));
  }
  return [];
}

function copyShifted(
  item: WallItem,
  shift: { dCol: number; dRow2: number },
  board: Board,
): WallItem {
  const cell = offsetCell(item.cell ?? { col: 0, row: 0 }, shift);
  const centre = cellCenter(board, cell);
  const { parentId: _parentId, ...rest } = item;
  return {
    ...rest,
    id: newId('i'),
    cell,
    pose: { ...item.pose, x: centre.x, y: centre.y },
    locked: false,
    source: { type: 'manual' },
  };
}
