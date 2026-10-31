import { FLOOR_Y_MM, itemWorldAabb, type Wall } from '@hsw-editor/core';
import type { Extent } from './wallExtent.ts';
import type { BankLookup } from '@/wall/edits.ts';
import { boundsAabb, itemBounds } from './itemBounds.ts';

/** A tool whose lowest point is this close (mm) to the floor lies on it. */
const ON_FLOOR_TOLERANCE_MM = 2;

/** Does a tool of the wall lie on the floor (so the floor is drawn)? Tools on a mount never do: the floor is 150 mm under the board. */
export function toolLiesOnFloor(wall: Wall, bank: BankLookup): boolean {
  return wall.items.some((item) => {
    if (item.kind !== 'tool' || item.parentId !== undefined) return false;
    const bounds = itemBounds(item, wall, bank);
    if (bounds === null) return false;
    return itemWorldAabb(boundsAabb(bounds), item.pose).min.y <= FLOOR_Y_MM + ON_FLOOR_TOLERANCE_MM;
  });
}

/** What the camera frames: the wall's extent and the floor's line under it, so the floor a tool falls to is in view without moving the camera. */
export function withFloor(extent: Extent): Extent {
  return { ...extent, y0: Math.min(extent.y0, FLOOR_Y_MM) };
}
