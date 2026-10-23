/**
 * Pose <-> pixel mapping for items drawn over the photo, and photo-space dragging: the pointer position in
 * photo px goes through the calibration to wall mm, snaps to the honeycomb, and comes back as the ghost that
 * the UI draws. The wall plane is the only surface the photo can measure, so items are projected as they
 * sit on it (z = 0); the camera-matched 3D view (`camera.ts`) adds depth for display.
 */
import type { Board, Pose } from '@hsw-editor/core';
import type { Vec2 } from './matrix.ts';
import type { PhotoMap } from './photo-map.ts';
import {
  snapPlacement,
  type Extent,
  type PlacementOptions,
  type PlacementSnap,
  type WallPoint,
} from './placement.ts';

/** The in-plane part of a core `Pose`: position (mm) and rotation about the wall normal (degrees, counter-clockwise from the room). */
export type WallPose2D = Pick<Pose, 'x' | 'y' | 'rotZ'>;

/** Photo px of an item pose's origin (the anchor cell centre). */
export function poseToPx(map: PhotoMap, pose: Pick<WallPose2D, 'x' | 'y'>): Vec2 | null {
  return map.wallToPx([pose.x, pose.y]);
}

/** Wall position under a photo px. */
export function pxToPosition(map: PhotoMap, px: Vec2): WallPoint | null {
  const wall = map.pxToWall(px);
  return wall === null ? null : { x: wall[0], y: wall[1] };
}

/** The 4 corners of an extent, counter-clockwise from the lower-left. */
export function extentCorners(extent: Extent): Vec2[] {
  return [
    [extent.minX, extent.minY],
    [extent.maxX, extent.minY],
    [extent.maxX, extent.maxY],
    [extent.minX, extent.maxY],
  ];
}

/**
 * Photo px polygon of an outline given in item-local mm (origin = anchor), rotated by `rotZ` and placed at the
 * pose. Returns null if any vertex projects beyond the horizon.
 */
export function outlineToPx(
  map: PhotoMap,
  pose: WallPose2D,
  localOutlineMm: readonly Vec2[],
): Vec2[] | null {
  const t = (pose.rotZ * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const out: Vec2[] = [];
  for (const [lx, ly] of localOutlineMm) {
    const px = map.wallToPx([pose.x + c * lx - s * ly, pose.y + s * lx + c * ly]);
    if (px === null) return null;
    out.push(px);
  }
  return out;
}

/** Wall-space polygon (e.g. an extent) to photo px. */
export function wallPolygonToPx(map: PhotoMap, polygon: readonly Vec2[]): Vec2[] | null {
  const out: Vec2[] = [];
  for (const p of polygon) {
    const px = map.wallToPx(p);
    if (px === null) return null;
    out.push(px);
  }
  return out;
}

export interface DragSnap {
  /** Pointer position in the photo. */
  pointerPx: Vec2;
  /** Wall position the pointer maps to, after removing the grab offset. */
  requestedMm: WallPoint;
  snap: PlacementSnap;
  /** Where the snapped anchor is in the photo. */
  ghostCenterPx: Vec2 | null;
  /** The snapped item's extent as a photo polygon. */
  ghostOutlinePx: Vec2[] | null;
}

/**
 * One step of a drag in photo space. `grabOffsetMm` is (item anchor - pointer) in wall mm at the moment the
 * drag started, so the item does not jump under the cursor. Null when the pointer is beyond the horizon.
 */
export function snapDrag(
  map: PhotoMap,
  board: Board,
  pointerPx: Vec2,
  options: PlacementOptions & { grabOffsetMm?: WallPoint } = {},
): DragSnap | null {
  const wall = map.pxToWall(pointerPx);
  if (wall === null) return null;
  const grab = options.grabOffsetMm ?? { x: 0, y: 0 };
  const requestedMm = { x: wall[0] + grab.x, y: wall[1] + grab.y };
  const snap = snapPlacement(board, requestedMm, options);
  const ghostCenterPx =
    snap.snapped === null ? null : map.wallToPx([snap.snapped.x, snap.snapped.y]);
  const ghostOutlinePx =
    snap.extentMm === null ? null : wallPolygonToPx(map, extentCorners(snap.extentMm));
  return { pointerPx, requestedMm, snap, ghostCenterPx, ghostOutlinePx };
}
