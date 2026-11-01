/**
 * How a tool sits in its holder, beyond "is it held": two ways a pose can be held and still wrong.
 *
 * - Wedged: the tool hangs in an opening of the holder on nothing but a line contact at its edge: the lowest end is in the
 *   opening, open air continues below it, and where the tool touches the holder from above it overlaps the rim by barely a
 *   millimetre (a flared tip caught in a hole that is too small for it). The handle then floats well above the rim while the
 *   physics sees contacts all around and calls it stable. A collar or handle that rests on the rim with a real overlap is a seat,
 *   however short the shaft below it.
 * - Protrudes: a part of the tool that is body, not a needle tip (pliers jaws, a wrench head), hangs out below the lowest point
 *   of the holder, so the rack is too shallow for the tool. Whether that matters depends on the holder (a rack: it does; a
 *   hammer fork or a rail the tool dangles from by design: it does not), which the caller decides with `protrudeLimitMm`.
 *
 * Both are read off the column grids of the tool at its pose and of the holder.
 */
import { type ColumnGrid, spanRange } from './columns.ts';
import type { Bounds } from './body.ts';

/** Open air (mm) that must continue below the lowest end of a tool for it to count as hanging in an opening, not resting on a floor. */
const OPEN_BELOW_MM = 8;
/** Tool columns this close (mm) to the lowest point of the tool make up its lowest end. */
const LOWEST_END_MM = 2;
/** Share of the lowest end's columns that must have open air below for the tool to be hanging in the opening. */
const OPEN_SHARE = 0.95;
/** Vertical gap (mm) at which a tool column counts as resting on the holder surface under it. */
const REST_GAP_MM = 0.6;
/** A tool that overlaps the rim by less than this (mm) hangs on the edge of the opening, not on the rim. */
const EDGE_OVERLAP_MM = 1.5;
/** How far (mm) from a contact column the opening is looked for. */
const OVERLAP_SEARCH_MM = 6;
/** Cross-section (mm2) from which a part of the tool is body and not a needle tip (a 3 mm round rod is 7 mm2). */
const BODY_SECTION_MM2 = 10;
/** Step (mm) at which the part of the tool below the holder is sliced. */
const SLICE_STEP_MM = 1;

/**
 * A tool whose end nests less than this (mm) in an opening is resting on its rim there, not caught in it: the jaws of pliers
 * in a rack slot and the head of a ring wrench nest a few millimetres and are seated. A jam is deeper. The generated racks and
 * rails have an 8 mm shelf, so a tip caught in one of their holes balances on the rim instead (the contacts say `tips`); this
 * is for the thick holders (the refit rail, 52 mm) where the tip goes in far enough to hang with the handle floating.
 */
export const WEDGED_MIN_MM = 8;

export interface SeatFit {
  /** How deep (mm) the lowest end of the tool is inside an opening it hangs in by an edge; 0 when it is not wedged. */
  wedgedMm: number;
  /** How far (mm) a part of the tool that is body reaches below the lowest point of the holder; 0 when none does. */
  protrudeMm: number;
}

/** A tool as the fit sees it: its columns on the world grid (cell shift `di`, `dj` and height `y` as in `toolGridAt`). */
export interface PlacedGrid {
  grid: ColumnGrid;
  di: number;
  dj: number;
  y: number;
}

interface Extent {
  /** Columns (holder cell indices) of the lowest end. */
  cells: [number, number][];
  minY: number;
  maxY: number;
}

function extentOf(tool: PlacedGrid): Extent {
  const { minY, maxY } = heightRange(tool);
  const cells: [number, number][] = [];
  if (!Number.isFinite(minY)) return { cells, minY, maxY };
  for (let j = tool.grid.j0; j < tool.grid.j0 + tool.grid.nz; j++) {
    for (let i = tool.grid.i0; i < tool.grid.i0 + tool.grid.nx; i++) {
      const [from, to] = spanRange(tool.grid, i, j);
      if (to > from && (tool.grid.spans[2 * from] ?? Infinity) + tool.y <= minY + LOWEST_END_MM) {
        cells.push([i + tool.di, j + tool.dj]);
      }
    }
  }
  return { cells, minY, maxY };
}

function heightRange(tool: PlacedGrid): { minY: number; maxY: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = tool.grid.j0; j < tool.grid.j0 + tool.grid.nz; j++) {
    for (let i = tool.grid.i0; i < tool.grid.i0 + tool.grid.nx; i++) {
      const [from, to] = spanRange(tool.grid, i, j);
      if (to === from) continue;
      minY = Math.min(minY, (tool.grid.spans[2 * from] ?? Infinity) + tool.y);
      maxY = Math.max(maxY, (tool.grid.spans[2 * to - 1] ?? -Infinity) + tool.y);
    }
  }
  return { minY, maxY };
}

/** Does the holder have material in the column between `y - depthMm` and `y - 0.3`? */
function materialBelow(
  holder: ColumnGrid,
  i: number,
  j: number,
  y: number,
  depthMm: number,
): boolean {
  const [from, to] = spanRange(holder, i, j);
  for (let s = from; s < to; s++) {
    const bottom = holder.spans[2 * s] ?? Infinity;
    const top = holder.spans[2 * s + 1] ?? -Infinity;
    if (top >= y - depthMm && bottom <= y - 0.3) return true;
  }
  return false;
}

/** Top of the holder surface in column (i, j) that a tool bottom at `bottom` rests on, or null when none is within the rest gap below it. */
function surfaceUnder(holder: ColumnGrid, i: number, j: number, bottom: number): number | null {
  const [from, to] = spanRange(holder, i, j);
  for (let s = from; s < to; s++) {
    const top = holder.spans[2 * s + 1] ?? -Infinity;
    if (bottom - top >= -0.02 && bottom - top <= REST_GAP_MM) return top;
  }
  return null;
}

/** Does the holder have material at height `y` (a surface at or above it, a floor at or below it) in column (i, j)? */
function solidAt(holder: ColumnGrid, i: number, j: number, y: number): boolean {
  const [from, to] = spanRange(holder, i, j);
  for (let s = from; s < to; s++) {
    if ((holder.spans[2 * s] ?? Infinity) <= y && (holder.spans[2 * s + 1] ?? -Infinity) >= y)
      return true;
  }
  return false;
}

/** Is column (i, j) inside the holder's raster? Beyond it (behind the board, past the end of the holder) there is no opening, only the outside. */
function inRaster(holder: ColumnGrid, i: number, j: number): boolean {
  return i >= holder.i0 && i < holder.i0 + holder.nx && j >= holder.j0 && j < holder.j0 + holder.nz;
}

/** Straight-line distance (mm) from column (i, j) to the nearest column of the raster without holder material at `y`, searched on the eight directions; the search limit when none is found. */
function distanceToOpening(holder: ColumnGrid, i: number, j: number, y: number): number {
  const reach = Math.ceil(OVERLAP_SEARCH_MM / holder.cellMm);
  let best = OVERLAP_SEARCH_MM;
  for (const [di, dj] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    for (let k = 1; k <= reach; k++) {
      const ci = i + di * k;
      const cj = j + dj * k;
      if (!inRaster(holder, ci, cj)) break;
      if (!solidAt(holder, ci, cj, y)) {
        best = Math.min(best, k * Math.hypot(di, dj) * holder.cellMm);
        break;
      }
    }
  }
  return best;
}

/**
 * How deep (mm) the lowest end hangs in the opening when it is held there by an edge: open air below the lowest end, the tool
 * rests on holder material that reaches down beside it, and nowhere does it overlap the rim by more than a millimetre or so.
 */
function wedgedDepth(
  tool: PlacedGrid,
  holder: ColumnGrid,
  extent: Extent,
  holderBottom: number,
): number {
  const { cells, minY } = extent;
  if (cells.length === 0 || minY < holderBottom + OPEN_BELOW_MM) return 0;
  const open = cells.filter(([i, j]) => !materialBelow(holder, i, j, minY, OPEN_BELOW_MM)).length;
  if (open < OPEN_SHARE * cells.length) return 0;
  const rim = rimAndOverlap(tool, holder, minY);
  if (rim === null || rim.overlap >= EDGE_OVERLAP_MM) return 0;
  return rim.rimTop - minY;
}

/** Highest holder surface the tool rests on beside its lowest end, and the largest overlap with the rim; null when none. */
function rimAndOverlap(
  tool: PlacedGrid,
  holder: ColumnGrid,
  minY: number,
): { rimTop: number; overlap: number } | null {
  const acc = { rimTop: -Infinity, overlap: -Infinity };
  for (let j = tool.grid.j0; j < tool.grid.j0 + tool.grid.nz; j++) {
    for (let i = tool.grid.i0; i < tool.grid.i0 + tool.grid.nx; i++) {
      accumulateRim(acc, tool, holder, i, j, minY);
    }
  }
  return Number.isFinite(acc.rimTop) ? acc : null;
}

function accumulateRim(
  acc: { rimTop: number; overlap: number },
  tool: PlacedGrid,
  holder: ColumnGrid,
  i: number,
  j: number,
  minY: number,
): void {
  const [from, to] = spanRange(tool.grid, i, j);
  for (let s = from; s < to; s++) {
    const bottom = (tool.grid.spans[2 * s] ?? Infinity) + tool.y;
    const top = surfaceUnder(holder, i + tool.di, j + tool.dj, bottom);
    if (top === null || top < minY + WEDGED_MIN_MM) continue;
    // The material the tool rests on must reach down beside the lowest end: the tool is in a hole of the holder. A ring
    // that hangs around a peg rests on the top of the peg, and the peg does not go down to the bottom of the ring.
    if (!solidAt(holder, i + tool.di, j + tool.dj, minY + 1)) continue;
    acc.rimTop = Math.max(acc.rimTop, top);
    acc.overlap = Math.max(
      acc.overlap,
      distanceToOpening(holder, i + tool.di, j + tool.dj, top - 0.3),
    );
  }
}

/** Cross-section (mm2) of the tool in the horizontal plane at world height `y`. */
function sectionMm2(tool: PlacedGrid, y: number, footprint: Bounds): number {
  let n = 0;
  const local = y - tool.y;
  const cell = tool.grid.cellMm;
  for (let j = tool.grid.j0; j < tool.grid.j0 + tool.grid.nz; j++) {
    for (let i = tool.grid.i0; i < tool.grid.i0 + tool.grid.nx; i++) {
      // Only what hangs below the holder counts as reaching out of it: a tool pulled sideways past it is somewhere else.
      const x = (i + tool.di + 0.5) * cell;
      const z = (j + tool.dj + 0.5) * cell;
      const inside =
        x >= footprint.min[0] &&
        x <= footprint.max[0] &&
        z >= footprint.min[2] &&
        z <= footprint.max[2];
      if (!inside) continue;
      if (occupiesHeight(tool.grid, i, j, local)) n++;
    }
  }
  return n * tool.grid.cellMm * tool.grid.cellMm;
}

function occupiesHeight(grid: ColumnGrid, i: number, j: number, local: number): boolean {
  const [from, to] = spanRange(grid, i, j);
  for (let s = from; s < to; s++) {
    if ((grid.spans[2 * s] ?? Infinity) <= local && (grid.spans[2 * s + 1] ?? -Infinity) >= local)
      return true;
  }
  return false;
}

function protrusion(tool: PlacedGrid, extent: Extent, footprint: Bounds): number {
  const { minY, maxY } = extent;
  const holderBottom = footprint.min[1];
  if (!Number.isFinite(minY) || minY >= holderBottom) return 0;
  let deepest = 0;
  // Only the heights the tool occupies are sliced: a tool far below the holder is as deep as it is long, not as far away as it is.
  const top = Math.min(holderBottom - SLICE_STEP_MM, maxY);
  // An integer slice count, not a running height: a pose absurdly far away must end the loop, not stall on `y - 2 === y`.
  for (let k = 0; k <= Math.floor((top - minY) / SLICE_STEP_MM); k++) {
    const y = top - k * SLICE_STEP_MM;
    if (sectionMm2(tool, y, footprint) >= BODY_SECTION_MM2) deepest = holderBottom - y;
  }
  return deepest;
}

const RACK_PROTRUDE_LIMIT_MM = 15;
/** Bank id prefixes of the racks that hold a tool by its jaws or head in a slot (the generated `pliers-rack` and `wrench-rack` families). */
const RACK_ID_PREFIXES: readonly string[] = ['pliers-rack-', 'wrench-rack-'];

/**
 * How far (mm) a tool may reach out below the holder with bank id `holderId` before it is too shallow for it; undefined where
 * tools dangle from the holder by design (a hammer fork, a rail's shafts, a cradle, the pliers saddle the handles hang from).
 * A rack holds the tool by its jaws or head in the slot: the rest of the tool belongs inside the rack, not below it.
 */
export function protrudeLimitMm(holderId: string): number | undefined {
  return RACK_ID_PREFIXES.some((prefix) => holderId.startsWith(prefix))
    ? RACK_PROTRUDE_LIMIT_MM
    : undefined;
}

/**
 * The fit of a tool at its pose in the holder whose bounds and column grid are given. `withProtrusion` is false when the holder
 * has no limit for it (`protrudeLimitMm`): the slicing is then skipped.
 */
export function measureSeatFit(
  tool: PlacedGrid,
  holder: ColumnGrid,
  holderBounds: Bounds,
  withProtrusion: boolean,
): SeatFit {
  const holderBottom = holderBounds.min[1];
  const extent = extentOf(tool);
  return {
    wedgedMm: wedgedDepth(tool, holder, extent, holderBottom),
    protrudeMm: withProtrusion ? protrusion(tool, extent, holderBounds) : 0,
  };
}
