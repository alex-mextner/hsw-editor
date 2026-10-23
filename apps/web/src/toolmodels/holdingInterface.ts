/** `ToolInterface` of `@hsw-editor/compat` for a tool drawn by a generated model: what the compatibility maths and the hang placement read. */
import { broaderToolClasses, type ToolClass } from '@hsw-editor/bank';
import type { ToolInterface } from '@hsw-editor/compat';
import type { HoldingSummary } from '@hsw-editor/tools/contract';

/** Names of the item params that override a tool's box (`toolDims`); they are sizes of the box, never measured holding dimensions. */
export const BOX_PARAM_KEY_NAMES: ReadonlySet<string> = new Set(['width', 'length', 'thickness']);

export function toolInterfaceFromHolding(
  toolClass: string,
  holding: HoldingSummary,
  params: Readonly<Record<string, number>>,
  vocabulary?: readonly Pick<ToolClass, 'id' | 'broader'>[],
): ToolInterface {
  return {
    toolClass,
    broader: broaderToolClasses(toolClass, vocabulary),
    lengthMm: holding.lengthMm,
    hang: holding.hang,
    maxSection: holding.maxSection,
    // What the model measures; the item's own named dimensions win, except the box sizes: a tape's `width` param is the
    // box, its holding `width` is the roll.
    dims: {
      ...holding.dims,
      ...Object.fromEntries(
        Object.entries(params).filter(([key]) => !BOX_PARAM_KEY_NAMES.has(key)),
      ),
    },
  };
}
