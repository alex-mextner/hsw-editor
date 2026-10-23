/**
 * Ruler guides and the snap preview of an item being dragged over the photo. Everything is computed in wall
 * millimetres from the same cells the editor uses, then carried to photo pixels through the calibration, so a
 * distance shown on the photo is a distance on the wall.
 */
import type { BankElement } from '@hsw-editor/bank';
import { boardSizeMm, nearestCell, type Board, type Wall, type WallItem } from '@hsw-editor/core';
import {
  cellsExtentMm,
  computeGuides,
  extentCorners,
  type Extent,
  type Guides,
  type PhotoMap,
  type Vec2,
} from '@hsw-editor/overlay';
import { footprintCells } from '@/wall/footprint.ts';
import type { PreviewPose } from '@/state/editor.ts';

export interface GuideSegment {
  readonly kind: 'edge' | 'neighbor';
  /** Wall mm; the segment runs along one axis. */
  readonly from: Vec2;
  readonly to: Vec2;
  readonly gapMm: number;
}

export interface DragGuides {
  readonly extent: Extent;
  readonly segments: readonly GuideSegment[];
}

function cellsOf(
  board: Board,
  item: WallItem,
  bank: ReadonlyMap<string, BankElement>,
  pose: { readonly x: number; readonly y: number; readonly rotZ: number },
) {
  const element = item.bankId === undefined ? undefined : bank.get(item.bankId);
  if (!element) return null;
  return footprintCells(element, nearestCell(board, pose.x, pose.y), pose.rotZ, board);
}

/** Segments from an extent to the board edges and to its nearest neighbours, in wall mm. */
export function guideSegments(extent: Extent, guides: Guides, board: Board): GuideSegment[] {
  const midX = (extent.minX + extent.maxX) / 2;
  const midY = (extent.minY + extent.maxY) / 2;
  const { width, height } = boardSizeMm(board);
  const out: GuideSegment[] = [
    { kind: 'edge', from: [extent.minX, midY], to: [0, midY], gapMm: guides.edges.left },
    { kind: 'edge', from: [extent.maxX, midY], to: [width, midY], gapMm: guides.edges.right },
    { kind: 'edge', from: [midX, extent.minY], to: [midX, 0], gapMm: guides.edges.bottom },
    { kind: 'edge', from: [midX, extent.maxY], to: [midX, height], gapMm: guides.edges.top },
  ];
  const { left, right, below, above } = guides.neighbors;
  if (left)
    out.push({
      kind: 'neighbor',
      from: [extent.minX, midY],
      to: [extent.minX - left.gapMm, midY],
      gapMm: left.gapMm,
    });
  if (right)
    out.push({
      kind: 'neighbor',
      from: [extent.maxX, midY],
      to: [extent.maxX + right.gapMm, midY],
      gapMm: right.gapMm,
    });
  if (below)
    out.push({
      kind: 'neighbor',
      from: [midX, extent.minY],
      to: [midX, extent.minY - below.gapMm],
      gapMm: below.gapMm,
    });
  if (above)
    out.push({
      kind: 'neighbor',
      from: [midX, extent.maxY],
      to: [midX, extent.maxY + above.gapMm],
      gapMm: above.gapMm,
    });
  return out;
}

/** Guides of the item being dragged (the pressed one), or null when nothing is being dragged. */
export function dragGuides(
  wall: Wall,
  bank: ReadonlyMap<string, BankElement>,
  dragging: ReadonlyMap<string, PreviewPose>,
  primaryId: string | undefined,
): DragGuides | null {
  if (primaryId === undefined) return null;
  const pose = dragging.get(primaryId);
  const item = wall.items.find((candidate) => candidate.id === primaryId);
  if (!pose || !item) return null;
  const cells = cellsOf(wall.board, item, bank, pose);
  if (!cells || cells.length === 0) return null;
  const occupied = wall.items.flatMap((other) => {
    if (other.id === primaryId || dragging.has(other.id) || other.cell === undefined) return [];
    const otherCells = cellsOf(wall.board, other, bank, other.pose);
    return otherCells ? [{ id: other.id, cells: otherCells }] : [];
  });
  const extent = cellsExtentMm(wall.board, cells);
  return {
    extent,
    segments: guideSegments(extent, computeGuides(wall.board, extent, occupied), wall.board),
  };
}

/** Wall mm points to photo px; null when any point is beyond the plane's horizon. */
export function toPx(map: PhotoMap, points: readonly Vec2[]): Vec2[] | null {
  const out: Vec2[] = [];
  for (const point of points) {
    const px = map.wallToPx(point);
    if (px === null) return null;
    out.push(px);
  }
  return out;
}

export function extentOutlinePx(map: PhotoMap, extent: Extent): Vec2[] | null {
  return toPx(map, extentCorners(extent));
}
