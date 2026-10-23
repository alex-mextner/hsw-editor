/**
 * Pure ranking helpers behind the variant picker: which holders fit a recognised tool, and which
 * bank elements are size/variant siblings of one another.
 */
import type { BankElement, BankIndex, DimRange, FitsTool } from '@hsw-editor/bank';

export type ElementPool = Pick<BankIndex, 'elements'>;

/** Measured dimensions of a tool in mm, keyed like `FitsTool.dims` (e.g. `shaftDiameter`, `width`). */
export type ToolDims = Readonly<Record<string, number>>;

export interface HolderSuggestion {
  readonly element: BankElement;
  /** Fit quality in [0, 1]: 1 = every known dimension lies in the holder's range, 0.5 = nothing known. */
  readonly score: number;
}

/** Score of a dimension that is not measured or not constrained: neither a match nor a mismatch. */
export const NEUTRAL_SCORE = 0.5;

/** How fast the score falls once a dimension leaves its range: 10% off the edge keeps ~45%. */
const DECAY_PER_RELATIVE_MISS = 8;

/** 1 inside the range, exponentially decaying with the miss relative to the nearest range edge. */
export function dimScore(value: number, range: DimRange): number {
  if (!Number.isFinite(value)) return NEUTRAL_SCORE;
  const miss = value < range.min ? range.min - value : value > range.max ? value - range.max : 0;
  if (miss === 0) return 1;
  const edge = value < range.min ? range.min : range.max;
  const relative = miss / Math.max(Math.abs(edge), Number.EPSILON);
  return Math.exp(-DECAY_PER_RELATIVE_MISS * relative);
}

/**
 * Geometric mean of the per-dimension scores, so one hopeless dimension sinks the holder instead of
 * being averaged away by the others. Dimensions the tool lacks (or the holder does not constrain)
 * count as neutral.
 */
export function fitScore(fit: FitsTool, dims: ToolDims | undefined): number {
  const ranges = Object.entries(fit.dims ?? {});
  if (ranges.length === 0 || !dims) return NEUTRAL_SCORE;
  let logSum = 0;
  for (const [key, range] of ranges) {
    const value = dims[key];
    const score = value === undefined ? NEUTRAL_SCORE : dimScore(value, range);
    logSum += Math.log(Math.max(score, Number.MIN_VALUE));
  }
  return Math.exp(logSum / ranges.length);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Elements whose `fitsTool` lists `toolClass`, best fit first. Ties go to the holder that holds more
 * objects, then to the smaller footprint (less wall used), then to the id for a stable order.
 */
export function holdersForToolClass(
  index: ElementPool,
  toolClass: string,
  dims?: ToolDims,
): HolderSuggestion[] {
  const ranked: Array<HolderSuggestion & { readonly capacity: number }> = [];
  for (const element of index.elements) {
    let best: { score: number; capacity: number } | null = null;
    for (const fit of element.fitsTool) {
      if (fit.toolClass !== toolClass) continue;
      const score = fitScore(fit, dims);
      const capacity = fit.capacity ?? 1;
      if (!best || score > best.score || (score === best.score && capacity > best.capacity)) {
        best = { score, capacity };
      }
    }
    if (best) ranked.push({ element, score: best.score, capacity: best.capacity });
  }
  ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.capacity - a.capacity ||
      a.element.footprint.cells.length - b.element.footprint.cells.length ||
      compareIds(a.element.id, b.element.id),
  );
  return ranked.map(({ element, score }) => ({ element, score }));
}

/**
 * The element and its siblings (same `family`), ordered by variant label (numeric-aware, so "6 slots"
 * precedes "12 slots") and then by dimensions. An element without a family is its own family.
 */
export function familyOf(index: ElementPool, element: BankElement): BankElement[] {
  const family = element.family;
  if (family === undefined) return [element];
  const members = index.elements.filter((candidate) => candidate.family === family);
  if (!members.some((member) => member.id === element.id)) members.push(element);
  return members.sort((a, b) => {
    const labelA = a.variantLabel?.en;
    const labelB = b.variantLabel?.en;
    if (labelA !== undefined && labelB === undefined) return -1;
    if (labelA === undefined && labelB !== undefined) return 1;
    const byLabel =
      labelA !== undefined && labelB !== undefined
        ? labelA.localeCompare(labelB, 'en', { numeric: true })
        : 0;
    return (
      byLabel ||
      a.dimsMm.x - b.dimsMm.x ||
      a.dimsMm.y - b.dimsMm.y ||
      a.dimsMm.z - b.dimsMm.z ||
      compareIds(a.id, b.id)
    );
  });
}
