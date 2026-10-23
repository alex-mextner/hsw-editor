/** Mean brightness of the wall photo behind the board, measured on a thumbnail of the photo. */
import { boardSizeMm, type Board } from '@hsw-editor/core';
import type { PhotoMap } from '@hsw-editor/overlay';
import { meanLuma } from './webContrast.ts';

const THUMB_SIDE = 96;

/** Photo-px bounding box of the board's four corners, clamped to the photo; null when none can be projected. */
export function boardPhotoBox(
  board: Board,
  map: PhotoMap,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const size = boardSizeMm(board);
  const corners = [
    map.wallToPx([0, 0]),
    map.wallToPx([size.width, 0]),
    map.wallToPx([size.width, size.height]),
    map.wallToPx([0, size.height]),
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const corner of corners) {
    if (corner === null) continue;
    x0 = Math.min(x0, corner[0]);
    y0 = Math.min(y0, corner[1]);
    x1 = Math.max(x1, corner[0]);
    y1 = Math.max(y1, corner[1]);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(map.image.width, x1);
  y1 = Math.min(map.image.height, y1);
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x0, y0, x1, y1 } : null;
}

/** Mean luma of the photo under the board; null when the browser cannot read the pixels. */
export function measureBackdropLuma(
  photo: CanvasImageSource,
  board: Board,
  map: PhotoMap,
): number | null {
  const box = boardPhotoBox(board, map);
  if (box === null) return null;
  const scale = THUMB_SIDE / Math.max(map.image.width, map.image.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(map.image.width * scale));
  canvas.height = Math.max(1, Math.round(map.image.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
  const x = Math.floor(box.x0 * scale);
  const y = Math.floor(box.y0 * scale);
  const width = Math.max(1, Math.ceil(box.x1 * scale) - x);
  const height = Math.max(1, Math.ceil(box.y1 * scale) - y);
  try {
    return meanLuma(ctx.getImageData(x, y, width, height).data);
  } catch {
    return null;
  }
}
