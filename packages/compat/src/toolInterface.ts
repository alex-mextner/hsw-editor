/** `ToolInterface` of a tool drawn by a generated model: what the editor and the agent's host tools both feed the compatibility maths. */
import type { HangPoint, ToolInterface } from './types.ts';

/** Names of the item params that override a tool's box (`toolDims`); they are sizes of the box, never measured holding dimensions. */
export const BOX_PARAM_KEY_NAMES: ReadonlySet<string> = new Set(['width', 'length', 'thickness']);

/** The measured part of a tool model's holding interface that the maths reads (`HoldingSummary` / `HoldingInterface` both satisfy it). */
export interface HoldingMeasure {
  readonly lengthMm: number;
  readonly hang: HangPoint | null;
  readonly maxSection: { readonly w: number; readonly t: number; readonly r: number };
  readonly dims: Readonly<Record<string, number>>;
}

/** The named holding dimensions among item `params` (everything but the box sizes). */
export function measuredDimensions(
  params: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(params).filter(([key]) => !BOX_PARAM_KEY_NAMES.has(key)),
  );
}

/**
 * `broader` are the coarser classes the tool also fits (`broaderToolClasses` of the bank vocabulary). The item's own
 * named dimensions win over what the model measures, except the box sizes: a tape's `width` param is the box, its
 * holding `width` is the roll.
 */
export function toolInterfaceFromHolding(
  toolClass: string,
  broader: readonly string[],
  holding: HoldingMeasure,
  params: Readonly<Record<string, number>>,
): ToolInterface {
  return {
    toolClass,
    broader,
    lengthMm: holding.lengthMm,
    hang: holding.hang,
    maxSection: holding.maxSection,
    dims: { ...holding.dims, ...measuredDimensions(params) },
  };
}
