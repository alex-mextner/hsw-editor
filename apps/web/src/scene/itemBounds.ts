import type { Vec3 } from '@hsw-editor/bank';
import type { Aabb, Wall, WallItem } from '@hsw-editor/core';
import { lastKnownElement } from '@/bank/client.ts';
import { bboxCentre, resolveModel } from '@/bank/models.ts';
import { resolveToolModel } from '@/toolmodels/resolve.ts';
import type { BankLookup } from '@/wall/edits.ts';
import { toolBoxCentre } from '@/wall/attach.ts';
import { toolDims } from '@/wall/toolPresets.ts';

export interface ItemBounds {
  /** Box size in mm. */
  readonly dims: Vec3;
  /** Box centre relative to the item's origin, in mm. */
  readonly centre: Vec3;
}

/** The box of `bounds` in the item's own frame. */
export function boundsAabb(bounds: ItemBounds): Aabb {
  const { dims, centre } = bounds;
  return {
    min: { x: centre.x - dims.x / 2, y: centre.y - dims.y / 2, z: centre.z - dims.z / 2 },
    max: { x: centre.x + dims.x / 2, y: centre.y + dims.y / 2, z: centre.z + dims.z / 2 },
  };
}

/** Stand-in size for an item with no known model at all. */
const FALLBACK_BOX: Vec3 = { x: 30, y: 30, z: 20 };

/**
 * Box drawn for an item without a loadable model: the element's real size if the bank ever told us
 * (the index may have been trimmed since), else the tool preset's, else a small generic box.
 */
export function placeholderBounds(item: WallItem, wall: Wall): ItemBounds {
  const known = item.bankId === undefined ? undefined : lastKnownElement(item.bankId);
  if (known) return { dims: known.dimsMm, centre: bboxCentre(known.bboxMm) };
  const dims = item.kind === 'tool' ? (toolDims(item, wall) ?? FALLBACK_BOX) : FALLBACK_BOX;
  return {
    dims,
    centre: item.kind === 'tool' ? toolBoxCentre(dims) : { x: 0, y: 0, z: dims.z / 2 },
  };
}

/** Bounding box used for selection frames and rotate handles: bank model dims, or a tool's box. */
export function itemBounds(item: WallItem, wall: Wall, bank: BankLookup): ItemBounds | null {
  const source = resolveModel(item, bank);
  if (source) return { dims: source.dimsMm, centre: source.centreMm };
  if (item.kind === 'tool') {
    const model = resolveToolModel(item, wall);
    if (model) return { dims: model.dimsMm, centre: model.centreMm };
    const dims = toolDims(item, wall);
    if (dims) return { dims, centre: toolBoxCentre(dims) };
  }
  // A bank element that is gone still has a box (and so a selection frame): the item stays editable.
  return item.bankId === undefined || item.kind === 'photo-ref'
    ? null
    : placeholderBounds(item, wall);
}
