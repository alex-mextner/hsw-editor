import type { BankElement } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { resolveModel } from '@/bank/models.ts';
import { itemBounds } from '../itemBounds.ts';
import { boxFromCentreDims, type ItemSolid } from './wallAdapter.ts';

/**
 * The solid an item is checked as: its bank GLB (full detail, absolute url because the worker resolves relative
 * urls against its own script), or the proportional stand-in box the scene draws for tools without a model.
 * The same bounds back the fallback box when the GLB cannot be loaded.
 */
export function itemSolid(
  item: WallItem,
  wall: Wall,
  bank: ReadonlyMap<string, BankElement>,
  baseUrl: string,
): ItemSolid | null {
  const bounds = itemBounds(item, wall, bank);
  if (!bounds) return null;
  const box = boxFromCentreDims(bounds.centre, bounds.dims);
  const model = resolveModel(item, bank);
  if (model) {
    return {
      solidKey: model.key,
      source: { kind: 'glb', url: new URL(model.lod0, baseUrl).href, fallbackBox: box },
    };
  }
  const { x, y, z } = bounds.dims;
  return { solidKey: `box:${x}x${y}x${z}`, source: { kind: 'box', box } };
}
