import type { Vec3 } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { resolveModel } from '@/bank/models.ts';
import type { BankLookup } from '@/wall/edits.ts';
import { toolDims } from '@/wall/toolPresets.ts';

export interface ItemBounds {
  /** Box size in mm. */
  readonly dims: Vec3;
  /** Box centre relative to the item's origin, in mm. */
  readonly centre: Vec3;
}

/** Bounding box used for selection frames and rotate handles: bank model dims, or a tool's box. */
export function itemBounds(item: WallItem, wall: Wall, bank: BankLookup): ItemBounds | null {
  const source = resolveModel(item, bank);
  if (source) return { dims: source.dimsMm, centre: source.centreMm };
  if (item.kind === 'tool') {
    const dims = toolDims(item, wall);
    if (dims) return { dims, centre: { x: 0, y: 0, z: dims.z / 2 } };
  }
  return null;
}
