/**
 * Holding interface of a wall tool item, as far as the editor knows it: the class (bank vocabulary), a
 * length from the preset box, and the item's named dimension overrides (`params`, e.g. `shaftDiameter`)
 * as the measured dimensions the compatibility maths compares against holder ranges. A tool drawn by a
 * generated model takes its measured holding interface (length, hang point, widest section, dims); a preset or
 * recognised tool without one has this approximation.
 */
import { broaderToolClasses, type ToolClass } from '@hsw-editor/bank';
import type { ToolInterface } from '@hsw-editor/compat';
import type { Wall, WallItem } from '@hsw-editor/core';
import { toolInterfaceFromHolding } from '@/toolmodels/holdingInterface.ts';
import { resolveToolModel } from '@/toolmodels/resolve.ts';
import { presetDims, toolDims } from './toolPresets.ts';

export function toolClassOfItem(item: WallItem, wall: Wall): string | undefined {
  if (item.toolClass !== undefined) return item.toolClass;
  const ref =
    item.modelRefId === undefined ? undefined : wall.models.find((m) => m.id === item.modelRefId);
  return ref?.toolClass;
}

/**
 * `vocabulary` is the loaded bank's tool classes; its `broader` links become `ToolInterface.broader` so a
 * holder made for the coarser class takes the tool. Classes it does not declare fall back to the built-in list.
 */
export function toolInterfaceOf(
  item: WallItem,
  wall: Wall,
  vocabulary?: readonly Pick<ToolClass, 'id' | 'broader'>[],
): ToolInterface | undefined {
  if (item.kind !== 'tool') return undefined;
  const toolClass = toolClassOfItem(item, wall);
  if (toolClass === undefined) return undefined;
  const model = resolveToolModel(item, wall, undefined, vocabulary);
  if (model) return toolInterfaceFromHolding(toolClass, model.holding, item.params, vocabulary);
  const box = toolDims(item, wall) ?? presetDims(toolClass);
  return {
    toolClass,
    broader: broaderToolClasses(toolClass, vocabulary),
    lengthMm: box.y,
    hang: null,
    maxSection: { w: box.x, t: box.z, r: Math.hypot(box.x, box.z) / 2 },
    dims: { ...item.params },
  };
}
