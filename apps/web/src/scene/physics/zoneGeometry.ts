import type { BankElement, Vec3 } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { resolveModel } from '@/bank/models.ts';
import { itemBounds } from '../itemBounds.ts';

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
 * The mesh the amber zones of a tool follow: its posed model, or the stand-in box the scene draws for tools without
 * one (the generated tool models arrive through `resolveModel`, so this is the single place that decides). The pose is
 * the item's own; null when the item has no extent at all.
 */
export function physicsZoneGeometry(
  item: WallItem,
  wall: Wall,
  bank: ReadonlyMap<string, BankElement>,
): ZoneGeometry | null {
  const bounds = itemBounds(item, wall, bank);
  if (!bounds) return null;
  return {
    modelUrl: resolveModel(item, bank)?.lod0 ?? null,
    dimsMm: bounds.dims,
    centreMm: bounds.centre,
    bankId: item.bankId,
  };
}
