/**
 * Holder suggestions for a tool, ranked by the compatibility maths of `@hsw-editor/compat`: only holders the tool
 * can actually hang on (class and measured dimensions inside the mount's ranges), best fit first.
 */
import { compatibility, type ToolInterface } from '@hsw-editor/compat';
import type { BankElement } from '@hsw-editor/bank';

export interface HolderSuggestion {
  readonly element: BankElement;
  /** Fit quality in [0, 1] from `compatibility`. */
  readonly score: number;
  /** How many objects the matching mount of the holder takes. */
  readonly capacity: number;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Ties go to the holder that holds more tools, then to the smaller footprint (less wall used), then to the id for
 * a stable order.
 */
export function suggestHolders(
  tool: ToolInterface,
  elements: readonly BankElement[],
): HolderSuggestion[] {
  const ranked: HolderSuggestion[] = [];
  for (const element of elements) {
    if (element.fitsTool.length === 0) continue;
    const result = compatibility(tool, element);
    if (!result.ok || result.entryIndex === null) continue;
    ranked.push({
      element,
      score: result.score,
      capacity: element.fitsTool[result.entryIndex]?.capacity ?? 1,
    });
  }
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.capacity - a.capacity ||
      a.element.footprint.cells.length - b.element.footprint.cells.length ||
      compareIds(a.element.id, b.element.id),
  );
}
