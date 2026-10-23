/**
 * Settle and overlap tests between a tool and obstacles in column form. The tool grid is rasterised in the tool's
 * oriented frame without translation; a placement is the integer cell shift (di, dj) plus a height `y`.
 */
import { type ColumnGrid, spanRange } from './columns.ts';

export interface ScanResult {
  /** Largest distance the tool can still fall without touching anything (Infinity: nothing below it). */
  fallMm: number;
  /** Deepest interpenetration (mm); 0 when the tool is clear. */
  penetrationMm: number;
}

/** Spans closer than this count as touching, not overlapping (rasterisation noise). */
const TOUCH_EPS_MM = 0.02;

/** One obstacle against the tool at shift (di, dj) and height y. */
export function scanObstacle(
  tool: ColumnGrid,
  obstacle: ColumnGrid,
  di: number,
  dj: number,
  y: number,
  stride = 1,
  abortBelowFallMm = -Infinity,
): ScanResult {
  let fall = Infinity;
  let penetration = 0;
  if (obstacle.nx === 0 || tool.nx === 0) return { fallMm: fall, penetrationMm: 0 };
  // Tool column (i, j) sits over obstacle column (i + di, j + dj): restrict to the overlapping cell range.
  const iFrom = Math.max(tool.i0, obstacle.i0 - di);
  const iTo = Math.min(tool.i0 + tool.nx - 1, obstacle.i0 + obstacle.nx - 1 - di);
  const jFrom = Math.max(tool.j0, obstacle.j0 - dj);
  const jTo = Math.min(tool.j0 + tool.nz - 1, obstacle.j0 + obstacle.nz - 1 - dj);
  for (let j = jFrom; j <= jTo; j += stride) {
    for (let i = iFrom; i <= iTo; i += stride) {
      const [t0, t1] = spanRange(tool, i, j);
      if (t1 === t0) continue;
      const [o0, o1] = spanRange(obstacle, i + di, j + dj);
      if (o1 === o0) continue;
      for (let t = t0; t < t1; t++) {
        const bottom = (tool.spans[2 * t] ?? 0) + y;
        const top = (tool.spans[2 * t + 1] ?? 0) + y;
        for (let o = o0; o < o1; o++) {
          const oBottom = obstacle.spans[2 * o] ?? 0;
          const oTop = obstacle.spans[2 * o + 1] ?? 0;
          if (bottom >= oTop - TOUCH_EPS_MM) {
            const gap = Math.max(0, bottom - oTop);
            if (gap < fall) {
              fall = gap;
              // The tool already rests higher than the caller cares about: stop looking.
              if (fall < abortBelowFallMm) return { fallMm: fall, penetrationMm: penetration };
            }
          } else if (top <= oBottom + TOUCH_EPS_MM) {
            // Tool is below this span: it does not limit a fall.
          } else {
            const depth = Math.min(oTop - bottom, top - oBottom);
            if (depth > penetration) penetration = depth;
          }
        }
      }
    }
  }
  return { fallMm: fall, penetrationMm: penetration };
}

export function scanAll(
  tool: ColumnGrid,
  obstacles: readonly ColumnGrid[],
  di: number,
  dj: number,
  y: number,
  stride = 1,
  abortBelowFallMm = -Infinity,
): ScanResult {
  let fall = Infinity;
  let penetration = 0;
  for (const obstacle of obstacles) {
    const r = scanObstacle(tool, obstacle, di, dj, y, stride, abortBelowFallMm);
    if (r.fallMm < fall) fall = r.fallMm;
    if (r.penetrationMm > penetration) penetration = r.penetrationMm;
    if (fall < abortBelowFallMm) break;
  }
  return { fallMm: fall, penetrationMm: penetration };
}

export interface Settled {
  /** Rest height of the tool origin; -Infinity when the tool falls through everything. */
  y: number;
  /** Interpenetration at the starting height (a start inside an obstacle is not a drop). */
  startPenetrationMm: number;
}

/** Drops the tool from `startY` until its first contact. */
export function settle(
  tool: ColumnGrid,
  obstacles: readonly ColumnGrid[],
  di: number,
  dj: number,
  startY: number,
): Settled {
  const r = scanAll(tool, obstacles, di, dj, startY);
  return { y: startY - r.fallMm, startPenetrationMm: r.penetrationMm };
}

/** Strides of the cheap lower-bound pass (a sparse subset of the tool columns can only fall further than all of them). */
const SPARSE_STRIDE = 4;

/**
 * `settle` for a search over many candidates: returns `null` as soon as the rest height is known to exceed
 * `maxRestY`. A sparse subset of the columns gives a lower bound of the rest height (fewer constraints, deeper
 * fall), which prunes most candidates before the full scan.
 */
export function settleBelow(
  tool: ColumnGrid,
  obstacles: readonly ColumnGrid[],
  di: number,
  dj: number,
  startY: number,
  maxRestY: number,
): Settled | null {
  const abortBelow = startY - maxRestY;
  if (Number.isFinite(maxRestY)) {
    const sparse = scanAll(tool, obstacles, di, dj, startY, SPARSE_STRIDE, abortBelow);
    if (sparse.fallMm < abortBelow) return null;
  }
  const r = scanAll(tool, obstacles, di, dj, startY, 1, abortBelow);
  if (r.fallMm < abortBelow) return null;
  return { y: startY - r.fallMm, startPenetrationMm: r.penetrationMm };
}

/**
 * How far the tool can rise (translate along +Y) from height `y` before an obstacle above it stops it; Infinity when
 * nothing is above any tool column. Spans that already overlap by less than `slackMm` (a seat rests within rounding of
 * its holder) do not count.
 */
export function riseLimit(
  tool: ColumnGrid,
  obstacles: readonly ColumnGrid[],
  di: number,
  dj: number,
  y: number,
  slackMm = 1,
): number {
  let limit = Infinity;
  for (const obstacle of obstacles) {
    if (obstacle.nx === 0 || tool.nx === 0) continue;
    const iFrom = Math.max(tool.i0, obstacle.i0 - di);
    const iTo = Math.min(tool.i0 + tool.nx - 1, obstacle.i0 + obstacle.nx - 1 - di);
    const jFrom = Math.max(tool.j0, obstacle.j0 - dj);
    const jTo = Math.min(tool.j0 + tool.nz - 1, obstacle.j0 + obstacle.nz - 1 - dj);
    for (let j = jFrom; j <= jTo; j++) {
      for (let i = iFrom; i <= iTo; i++) {
        const [t0, t1] = spanRange(tool, i, j);
        const [o0, o1] = spanRange(obstacle, i + di, j + dj);
        if (t1 === t0 || o1 === o0) continue;
        for (let t = t0; t < t1; t++) {
          const top = (tool.spans[2 * t + 1] ?? 0) + y;
          const bottom = (tool.spans[2 * t] ?? 0) + y;
          for (let o = o0; o < o1; o++) {
            const oBottom = obstacle.spans[2 * o] ?? 0;
            const oTop = obstacle.spans[2 * o + 1] ?? 0;
            // Obstacle span above the tool span: it limits the rise by the gap; overlapping spans are in the way
            // for good unless the overlap is rounding.
            if (oBottom >= top - slackMm) {
              const gap = Math.max(0, oBottom - top);
              if (gap < limit) limit = gap;
            } else if (oTop > bottom + slackMm && oBottom < top - slackMm) {
              return 0;
            }
          }
        }
      }
    }
  }
  return limit;
}
