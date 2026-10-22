/**
 * Placement snapping: a free position in wall space (what the pointer is over, in mm) becomes the nearest
 * honeycomb anchor cell where the item's whole footprint fits on the board, with collision warnings and the
 * mm ruler guides the UI draws. Pure and deterministic: snapping a snapped placement returns it unchanged.
 */
import {
  boardSizeMm,
  cellAtOffset,
  cellCenter,
  cellInBoard,
  nearestCell,
  rotateCellOffset,
  snapRotationDeg,
  type Board,
  type CellOffset,
  type GridCell,
} from '@hsw-editor/core';
import { MM_EPSILON } from './units.ts';

/** A point on the wall plane, mm (x right, y up, origin at the board's lower-left corner). */
export interface WallPoint {
  x: number;
  y: number;
}

export const SINGLE_CELL: readonly CellOffset[] = [{ dCol: 0, dRow2: 0 }];

export function footprintCells(anchor: GridCell, footprint: readonly CellOffset[]): GridCell[] {
  return footprint.map((offset) => cellAtOffset(anchor, offset));
}

/**
 * The footprint turned by `rotZDeg` about the anchor. Holders only rotate by the honeycomb's 60 degree symmetry, so
 * the angle is snapped to it. Validates the unrotated offsets (rotating first would hide an off-lattice offset behind
 * a valid rotated one) and the angle: `RangeError` for bad data.
 */
export function rotatedFootprint(
  board: Board,
  footprint: readonly CellOffset[],
  rotZDeg = 0,
): CellOffset[] {
  footprintCells({ col: 0, row: 0 }, footprint);
  if (!Number.isFinite(rotZDeg)) throw new RangeError('rotZ must be a finite number of degrees');
  const turn = snapRotationDeg(rotZDeg);
  return turn === 0 ? [...footprint] : footprint.map((o) => rotateCellOffset(board, o, turn));
}

/**
 * The cells an item covers. Use this for the dragged item AND for every `Occupant`, so both sides of a collision
 * test judge the same cells.
 */
export function itemCells(
  board: Board,
  anchor: GridCell,
  footprint: readonly CellOffset[],
  rotZDeg = 0,
): GridCell[] {
  return footprintCells(anchor, rotatedFootprint(board, footprint, rotZDeg));
}

export interface Occupant {
  id: string;
  /** Absolute cells the item covers. */
  cells: readonly GridCell[];
}

export interface Extent {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Bounding box (mm) of whole cells: centres +- half a pitch. */
export function cellsExtentMm(board: Board, cells: readonly GridCell[]): Extent {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    const c = cellCenter(board, cell);
    minX = Math.min(minX, c.x - board.colPitchMm / 2);
    maxX = Math.max(maxX, c.x + board.colPitchMm / 2);
    minY = Math.min(minY, c.y - board.rowPitchMm / 2);
    maxY = Math.max(maxY, c.y + board.rowPitchMm / 2);
  }
  return { minX, maxX, minY, maxY };
}

/** Bounding box of an extent turned by `rotZDeg` about the origin (the anchor). */
export function rotateExtent(extent: Extent, rotZDeg: number): Extent {
  const t = (rotZDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of [
    [extent.minX, extent.minY],
    [extent.maxX, extent.minY],
    [extent.maxX, extent.maxY],
    [extent.minX, extent.maxY],
  ] as const) {
    const rx = c * x - s * y;
    const ry = s * x + c * y;
    minX = Math.min(minX, rx);
    maxX = Math.max(maxX, rx);
    minY = Math.min(minY, ry);
    maxY = Math.max(maxY, ry);
  }
  return { minX, maxX, minY, maxY };
}

export type PlacementReason =
  /** The requested point already was an anchor cell centre. */
  | { code: 'exact' }
  | { code: 'nearest-cell' }
  /** The nearest cell would push the footprint off the board (or the pointer was past the edge): kept on the board. */
  | { code: 'kept-in-board' }
  /** `avoidCollisions`: the nearest cell was taken; moved to the nearest free one. */
  | { code: 'free-cell' }
  /** The footprint does not fit on the board anywhere. */
  | { code: 'footprint-too-large' }
  /** `avoidCollisions`: the footprint fits, but every position overlaps another item. */
  | { code: 'no-free-cell' };

export interface PlacementWarning {
  code: 'collision';
  itemIds: string[];
  cells: GridCell[];
}

export interface DistanceTo {
  gapMm: number;
  itemId?: string;
}

export interface Guides {
  /** Distance from the item's extent to each board edge, mm (negative = past the edge). */
  edges: { left: number; right: number; bottom: number; top: number };
  /** Nearest other item in each direction whose extent overlaps this one's in the perpendicular axis. */
  neighbors: { left?: DistanceTo; right?: DistanceTo; below?: DistanceTo; above?: DistanceTo };
}

export interface PlacementSnap {
  requested: WallPoint;
  /** Null when no placement exists (see `reason`). */
  snapped: { cell: GridCell; x: number; y: number } | null;
  /** How far the snap moved the anchor from the requested point. */
  movedMm: number;
  reason: PlacementReason;
  warnings: PlacementWarning[];
  guides: Guides | null;
  /** Wall-space extent of the snapped item (cells or `extentRelMm` around the anchor). */
  extentMm: Extent | null;
}

export interface PlacementOptions {
  /** Defaults to a single cell. */
  footprint?: readonly CellOffset[];
  /** The item's rotation about the wall normal (degrees): turns the footprint and the extent. */
  rotZDeg?: number;
  /** Other items (the dragged one excluded). */
  occupied?: readonly Occupant[];
  /** Search for the nearest cell without overlaps instead of only warning. */
  avoidCollisions?: boolean;
  /** Real extent of the item relative to the anchor cell centre (bank `bboxMm`) before rotation; defaults to the cells' extent. */
  extentRelMm?: Extent;
}

function cellKey(cell: GridCell): string {
  return `${cell.col},${cell.row}`;
}

function buildOccupancy(occupied: readonly Occupant[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const occupant of occupied) {
    for (const cell of occupant.cells) {
      const key = cellKey(cell);
      const ids = map.get(key);
      if (ids === undefined) map.set(key, [occupant.id]);
      else if (!ids.includes(occupant.id)) ids.push(occupant.id);
    }
  }
  return map;
}

export function snapPlacement(
  board: Board,
  requested: WallPoint,
  options: PlacementOptions = {},
): PlacementSnap {
  // Validated once, up front, instead of on every candidate anchor.
  const footprint = rotatedFootprint(board, options.footprint ?? SINGLE_CELL, options.rotZDeg);
  const rotZDeg = snapRotationDeg(options.rotZDeg ?? 0);
  const occupied = options.occupied ?? [];
  const occupancy = buildOccupancy(occupied);
  const fits = (anchor: GridCell): boolean =>
    footprint.every((offset) => cellInBoard(board, cellAtOffset(anchor, offset)));
  const hasCollision = (anchor: GridCell): boolean =>
    footprint.some((offset) => occupancy.has(cellKey(cellAtOffset(anchor, offset))));
  const collisions = (anchor: GridCell): { ids: string[]; cells: GridCell[] } => {
    const ids = new Set<string>();
    const cells: GridCell[] = [];
    for (const cell of footprintCells(anchor, footprint)) {
      const hit = occupancy.get(cellKey(cell));
      if (hit === undefined) continue;
      cells.push(cell);
      for (const id of hit) ids.add(id);
    }
    return { ids: [...ids], cells };
  };
  const wantsFree = options.avoidCollisions === true;
  const size = boardSizeMm(board);
  const none = (reason: PlacementReason): PlacementSnap => ({
    requested,
    snapped: null,
    movedMm: 0,
    reason,
    warnings: [],
    guides: null,
    extentMm: null,
  });

  const nearest = nearestCell(board, requested.x, requested.y);
  let chosen: GridCell | null = null;
  // `nearestCell` clamps to the board, so a pointer past the edge lands on an edge cell: say so instead of "nearest".
  const pointerOnBoard =
    requested.x >= 0 && requested.x <= size.width && requested.y >= 0 && requested.y <= size.height;
  let reason: PlacementReason = pointerOnBoard
    ? { code: 'nearest-cell' }
    : { code: 'kept-in-board' };
  if (fits(nearest) && !(wantsFree && hasCollision(nearest))) {
    chosen = nearest;
  } else {
    // Slow path (near an edge, or the nearest cell is taken): nearest anchor by distance among those that qualify.
    let bestDistance = Infinity;
    let anyFits = false;
    for (let col = 0; col < board.cols; col++) {
      for (let row = 0; row < board.rows; row++) {
        const anchor = { col, row };
        if (!fits(anchor)) continue;
        anyFits = true;
        if (wantsFree && hasCollision(anchor)) continue;
        const c = cellCenter(board, anchor);
        const distance = (c.x - requested.x) ** 2 + (c.y - requested.y) ** 2;
        if (distance >= bestDistance) continue;
        bestDistance = distance;
        chosen = anchor;
      }
    }
    if (chosen === null) return none({ code: anyFits ? 'no-free-cell' : 'footprint-too-large' });
    reason = fits(nearest) ? { code: 'free-cell' } : { code: 'kept-in-board' };
  }
  const centre = cellCenter(board, chosen);
  const movedMm = Math.hypot(centre.x - requested.x, centre.y - requested.y);
  if (movedMm <= MM_EPSILON && reason.code === 'nearest-cell') reason = { code: 'exact' };
  const hit = collisions(chosen);
  const warnings: PlacementWarning[] =
    hit.ids.length > 0 ? [{ code: 'collision', itemIds: hit.ids, cells: hit.cells }] : [];
  const rel = options.extentRelMm === undefined ? null : rotateExtent(options.extentRelMm, rotZDeg);
  const extentMm =
    rel === null
      ? cellsExtentMm(board, footprintCells(chosen, footprint))
      : {
          minX: centre.x + rel.minX,
          maxX: centre.x + rel.maxX,
          minY: centre.y + rel.minY,
          maxY: centre.y + rel.maxY,
        };
  return {
    requested,
    snapped: { cell: chosen, x: centre.x, y: centre.y },
    movedMm,
    reason,
    warnings,
    guides: computeGuides(board, extentMm, occupied),
    extentMm,
  };
}

/** Ruler guides: distances to the board edges and to the nearest neighbours, in mm. */
export function computeGuides(board: Board, extent: Extent, occupied: readonly Occupant[]): Guides {
  const size = boardSizeMm(board);
  const neighbors: Guides['neighbors'] = {};
  const consider = (slot: keyof Guides['neighbors'], gapMm: number, itemId: string): void => {
    if (gapMm < -MM_EPSILON) return;
    const current = neighbors[slot];
    if (current === undefined || gapMm < current.gapMm) neighbors[slot] = { gapMm, itemId };
  };
  const overlap = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;
  for (const other of occupied) {
    if (other.cells.length === 0) continue;
    const o = cellsExtentMm(board, other.cells);
    if (overlap(extent.minY, extent.maxY, o.minY, o.maxY)) {
      consider('left', extent.minX - o.maxX, other.id);
      consider('right', o.minX - extent.maxX, other.id);
    }
    if (overlap(extent.minX, extent.maxX, o.minX, o.maxX)) {
      consider('below', extent.minY - o.maxY, other.id);
      consider('above', o.minY - extent.maxY, other.id);
    }
  }
  return {
    edges: {
      left: extent.minX,
      right: size.width - extent.maxX,
      bottom: extent.minY,
      top: size.height - extent.maxY,
    },
    neighbors,
  };
}

export interface RotationSnap {
  requestedDeg: number;
  snappedDeg: number;
  changed: boolean;
}

/** Holders rotate in multiples of the honeycomb's 60 degree symmetry. */
export function snapRotation(requestedDeg: number): RotationSnap {
  const snappedDeg = snapRotationDeg(requestedDeg);
  const circularDiff = Math.abs(((((requestedDeg - snappedDeg) % 360) + 540) % 360) - 180);
  return { requestedDeg, snappedDeg, changed: circularDiff > 1e-9 };
}
