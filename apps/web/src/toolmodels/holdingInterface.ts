/** `ToolInterface` of `@hsw-editor/compat` for a tool drawn by a generated model: what the compatibility maths and the hang placement read. */
import { broaderToolClasses, type ToolClass } from '@hsw-editor/bank';
import {
  toolInterfaceFromHolding as interfaceFromHolding,
  type ToolInterface,
} from '@hsw-editor/compat';
import type { HoldingSummary } from '@hsw-editor/tools/contract';

export function toolInterfaceFromHolding(
  toolClass: string,
  holding: HoldingSummary,
  params: Readonly<Record<string, number>>,
  vocabulary?: readonly Pick<ToolClass, 'id' | 'broader'>[],
): ToolInterface {
  return interfaceFromHolding(
    toolClass,
    broaderToolClasses(toolClass, vocabulary),
    holding,
    params,
  );
}
