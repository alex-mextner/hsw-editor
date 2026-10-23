import type { BankElement, Vec3 } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { resolveModel, type ModelSource } from '@/bank/models.ts';
import { placeholderBounds } from './itemBounds.ts';

/** An element a wall item points at that the loaded bank does not have (kept, drawn as a placeholder). */
export interface MissingElement {
  readonly bankId: string;
  /** Best name we have: the item's own label, else the bank id. */
  readonly name: string;
}

export interface ItemGroup {
  readonly source: ModelSource | null;
  /** Box stand-in for items without a bank model (tool presets, missing assets). */
  readonly boxMm: Vec3;
  /** Box centre relative to the item origin (mm). */
  readonly centreMm: Vec3;
  readonly items: WallItem[];
  /** Set when every item of the group references an element that is not in the bank. */
  readonly missing: MissingElement | null;
}

/**
 * Items sharing one model (or one stand-in box) draw together as a single instanced group. Items
 * whose bank element is absent from a loaded bank are grouped per element id and flagged `missing`.
 * Nothing is dropped: every non-photo item lands in exactly one group.
 */
export function groupItems(
  wall: Wall,
  bank: ReadonlyMap<string, BankElement>,
  bankReady: boolean,
): [string, ItemGroup][] {
  const byKey = new Map<string, ItemGroup>();
  for (const item of wall.items) {
    if (item.kind === 'photo-ref') continue;
    const source = resolveModel(item, bank);
    const missingId =
      source === null && bankReady && item.bankId !== undefined && !bank.has(item.bankId)
        ? item.bankId
        : null;
    const bounds = placeholderBounds(item, wall);
    const key =
      source?.key ??
      (missingId === null
        ? `box:${bounds.centre.y}:${bounds.dims.x}x${bounds.dims.y}x${bounds.dims.z}`
        : `missing:${missingId}`);
    const group = byKey.get(key);
    if (group) group.items.push(item);
    else {
      byKey.set(key, {
        source,
        boxMm: bounds.dims,
        centreMm: bounds.centre,
        items: [item],
        missing: missingId === null ? null : { bankId: missingId, name: item.label ?? missingId },
      });
    }
  }
  return [...byKey.entries()];
}
