import type { BankElement, Vec3 } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { resolveModel } from '@/bank/models.ts';
import { resolveToolModel } from '@/toolmodels/resolve.ts';
import { itemBounds, placeholderBounds } from '../itemBounds.ts';

/** What the amber marks of one tool are drawn on: its model when there is one, always with the stand-in box. */
export interface ZoneGeometry {
  /** GLB of the tool (mm, item frame), or null when only the stand-in box exists. */
  readonly modelUrl: string | null;
  /** Stand-in box size, mm; also what is drawn while the model loads or when it fails. */
  readonly dimsMm: Vec3;
  /** Stand-in box centre in the item frame, mm. */
  readonly centreMm: Vec3;
  /** Display name for load-failure reporting. */
  readonly bankId: string | undefined;
}

/**
 * The mesh the amber zones of a tool follow: its posed generated model (`resolveToolModel`, what the scene draws), or the
 * stand-in box for a tool without one. The pose is the item's own; null when the item has no extent at all.
 */
export function physicsZoneGeometry(
  item: WallItem,
  wall: Wall,
  bank: ReadonlyMap<string, BankElement>,
): ZoneGeometry | null {
  // A tool with no known size is still drawn (as the generic placeholder box) and must be marked on that same box.
  const bounds =
    itemBounds(item, wall, bank) ?? (item.kind === 'tool' ? placeholderBounds(item, wall) : null);
  if (!bounds) return null;
  return {
    // The model the scene draws, in its order: a bank element first, else a tool's generated model (light level).
    modelUrl:
      resolveModel(item, bank)?.lod0 ??
      (item.kind === 'tool' ? (resolveToolModel(item, wall)?.lod1 ?? null) : null),
    dimsMm: bounds.dims,
    centreMm: bounds.centre,
    bankId: item.bankId,
  };
}
