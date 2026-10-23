/**
 * Holding interface of a wall tool item, as far as the editor knows it: the class (bank vocabulary), a
 * length from the preset box, and the item's named dimension overrides (`params`, e.g. `shaftDiameter`)
 * as the measured dimensions the compatibility maths compares against holder ranges. Generated tool
 * models would provide a measured interface instead; this is what a preset or recognised tool has.
 */
import type { ToolInterface } from '@hsw-editor/compat';
import type { Wall, WallItem } from '@hsw-editor/core';
import { presetDims, toolDims } from './toolPresets.ts';

export function toolClassOfItem(item: WallItem, wall: Wall): string | undefined {
  if (item.toolClass !== undefined) return item.toolClass;
  const ref =
    item.modelRefId === undefined ? undefined : wall.models.find((m) => m.id === item.modelRefId);
  return ref?.toolClass;
}

export function toolInterfaceOf(item: WallItem, wall: Wall): ToolInterface | undefined {
  if (item.kind !== 'tool') return undefined;
  const toolClass = toolClassOfItem(item, wall);
  if (toolClass === undefined) return undefined;
  const box = toolDims(item, wall) ?? presetDims(toolClass);
  return {
    toolClass,
    lengthMm: box.y,
    hang: null,
    maxSection: { w: box.x, t: box.z, r: Math.hypot(box.x, box.z) / 2 },
    dims: { ...item.params },
  };
}
