/**
 * `compatibility(tool, holder)`: can this tool hang on this holder, how well, and if not, why.
 * Pure and deterministic; the holder's current occupancy is passed in, never read from a wall.
 */
import { roundTo } from './rotation.ts';
import {
  BLOCKING_REASONS,
  type Clearance,
  type Compatibility,
  type HolderSpec,
  type MountEntry,
  type Reason,
  type ToolInterface,
} from './types.ts';

export interface CompatibilityOptions {
  /** Tools already occupying the holder (excluding the one being tested); default 0. */
  occupied?: number;
}

const SCORE_BASE = 0.6;
const SCORE_DIMS = 0.3;
const SCORE_CLASS_ONLY = 0.15;
const SCORE_DEDICATED = 0.1;
/**
 * Taken off the score when the entry lists only a coarser class of the tool. It equals the whole dedicated bonus, so
 * of two holders that fit equally well in their dimensions the one that names the tool's class ranks first,
 * whatever else it holds; a much better dimensional fit can still outweigh it.
 */
export const SCORE_BROADER_PENALTY = SCORE_DEDICATED;

function evaluateEntry(
  tool: ToolInterface,
  entry: MountEntry,
  entryCount: number,
  occupied: number,
  isBroader: boolean,
): Omit<Compatibility, 'entryIndex'> {
  const reasons: Reason[] = [];
  const clearances: Clearance[] = [];
  const fits: number[] = [];

  for (const [key, range] of Object.entries(entry.dims ?? {})) {
    const value = tool.dims[key];
    if (value === undefined) {
      reasons.push({ code: 'dim_unknown', params: { key } });
      fits.push(0.5);
      continue;
    }
    const marginMm = roundTo(Math.min(value - range.min, range.max - value));
    clearances.push({ key, valueMm: value, minMm: range.min, maxMm: range.max, marginMm });
    if (value > range.max) {
      reasons.push({
        code: 'dim_too_large',
        params: {
          key,
          valueMm: roundTo(value, 4),
          maxMm: range.max,
          overMm: roundTo(value - range.max, 4),
        },
      });
    } else if (value < range.min) {
      reasons.push({
        code: 'dim_too_small',
        params: {
          key,
          valueMm: roundTo(value, 4),
          minMm: range.min,
          underMm: roundTo(range.min - value, 4),
        },
      });
    }
    const half = (range.max - range.min) / 2;
    const offCentre = Math.abs(value - (range.min + half));
    fits.push(half === 0 ? (offCentre === 0 ? 1 : 0) : Math.max(0, 1 - offCentre / half));
  }

  const capacity = entry.capacity ?? 1;
  if (occupied >= capacity) {
    reasons.push({ code: 'slots_full', params: { capacity, occupied } });
  }
  if (entry.maxLoadG !== undefined && tool.massG !== undefined && tool.massG > entry.maxLoadG) {
    reasons.push({ code: 'overload', params: { massG: tool.massG, maxLoadG: entry.maxLoadG } });
  }

  const ok = !reasons.some((reason) => BLOCKING_REASONS.has(reason.code));
  if (!ok) return { ok, score: 0, reasons, clearances };
  const dimsScore =
    fits.length === 0
      ? SCORE_CLASS_ONLY
      : (SCORE_DIMS * fits.reduce((a, b) => a + b, 0)) / fits.length;
  const score = roundTo(
    SCORE_BASE + dimsScore + SCORE_DEDICATED / entryCount - (isBroader ? SCORE_BROADER_PENALTY : 0),
    4,
  );
  return { ok, score, reasons, clearances };
}

export function compatibility(
  tool: ToolInterface,
  holder: HolderSpec,
  options: CompatibilityOptions = {},
): Compatibility {
  if (holder.fitsTool.length === 0) {
    return {
      ok: false,
      score: 0,
      reasons: [{ code: 'not_a_mount', params: { category: holder.category } }],
      clearances: [],
      entryIndex: null,
    };
  }
  const occupied = options.occupied ?? 0;
  let best: (Omit<Compatibility, 'entryIndex'> & { entryIndex: number }) | null = null;
  for (const [index, entry] of holder.fitsTool.entries()) {
    const exact = entry.toolClass === tool.toolClass;
    if (!exact && !tool.broader?.includes(entry.toolClass)) continue;
    const result = {
      ...evaluateEntry(tool, entry, holder.fitsTool.length, occupied, !exact),
      entryIndex: index,
    };
    const fewerProblems =
      best !== null && best.score === 0 && result.reasons.length < best.reasons.length;
    if (best === null || result.score > best.score || (result.score === 0 && fewerProblems)) {
      best = result;
    }
  }
  if (best !== null) return best;
  return {
    ok: false,
    score: 0,
    reasons: [
      {
        code: 'class_mismatch',
        params: {
          toolClass: tool.toolClass,
          accepts: [...new Set(holder.fitsTool.map((entry) => entry.toolClass))],
        },
      },
    ],
    clearances: [],
    entryIndex: null,
  };
}

/** How a tool really hangs on a holder and how easily it comes off, as the physics measured it (both 0..1). */
export interface PhysicsRating {
  stability: number;
  /** Null when the removal was not analysed. */
  convenience: number | null;
}

/** Hang stability and removal convenience as one rating: stability counts twice as much as convenience. */
export function physicsRating(physics: PhysicsRating): number {
  return roundTo((2 * physics.stability + (physics.convenience ?? physics.stability)) / 3, 2);
}

/** Weight of the dimensional fit in the final order of holder suggestions: the rest is the physics rating. */
export const FIT_WEIGHT = 0.3;

/** Sort key from a fit score and a physics rating (both 0..1). */
export function foldFitAndRating(fit: number, rating: number): number {
  return roundTo(FIT_WEIGHT * fit + (1 - FIT_WEIGHT) * rating, 4);
}

/**
 * Sort key of a holder suggestion: the dimensional fit of `compatibility()` together with the physics. Holders the
 * tool does not fit stay at 0; a holder without a physics verdict keeps its fit score.
 */
export function rankWithPhysics(compat: Compatibility, physics: PhysicsRating | undefined): number {
  if (!compat.ok) return 0;
  return physics === undefined
    ? compat.score
    : foldFitAndRating(compat.score, physicsRating(physics));
}
