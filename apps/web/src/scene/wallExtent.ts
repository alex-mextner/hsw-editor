import { boardSizeMm, itemWorldAabb, type Wall } from '@hsw-editor/core';
import type { BankLookup } from '@/wall/edits.ts';
import { itemBounds } from './itemBounds.ts';

/** Rectangle in the wall plane (mm). */
export interface Extent {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Longest overhang past the board edge the view makes room for; a stray far-away item must not shrink the wall to a dot. */
const MAX_OVERHANG_MM = 600;

/**
 * What the view frames: the board plus every item that hangs, sticks up or sticks out beyond its edge (a screwdriver on
 * the top row, a saw taller than the wall). Tools are allowed there as long as their sizes are real; the camera must not
 * hide them. The overhang is capped so one item dragged far away does not zoom the wall out of sight.
 */
export function wallExtent(wall: Wall, bank: BankLookup): Extent {
  const { width, height } = boardSizeMm(wall.board);
  let x0 = 0;
  let y0 = 0;
  let x1 = width;
  let y1 = height;
  for (const item of wall.items) {
    const bounds = itemBounds(item, wall, bank);
    if (!bounds) continue;
    const { dims, centre } = bounds;
    const box = itemWorldAabb(
      {
        min: { x: centre.x - dims.x / 2, y: centre.y - dims.y / 2, z: centre.z - dims.z / 2 },
        max: { x: centre.x + dims.x / 2, y: centre.y + dims.y / 2, z: centre.z + dims.z / 2 },
      },
      item.pose,
    );
    x0 = Math.min(x0, Math.max(box.min.x, -MAX_OVERHANG_MM));
    y0 = Math.min(y0, Math.max(box.min.y, -MAX_OVERHANG_MM));
    x1 = Math.max(x1, Math.min(box.max.x, width + MAX_OVERHANG_MM));
    y1 = Math.max(y1, Math.min(box.max.y, height + MAX_OVERHANG_MM));
  }
  return { x0, y0, x1, y1 };
}
