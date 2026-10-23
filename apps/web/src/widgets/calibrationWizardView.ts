/** Pure helpers between the overlay wizard state machine and the calibration panel. */
import {
  createPhotoMap,
  extentCorners,
  wallPolygonToPx,
  type BoardExtent,
  type CalibrationResult,
  type ImageSize,
} from '@hsw-editor/overlay';

import type { Point2 } from './calibrationView.ts';

/** The board outline as the calibration places it in the photo (what the user checks the fit against). */
export function boardOutlinePx(
  result: CalibrationResult,
  image: ImageSize,
  extent: BoardExtent,
): readonly Point2[] | null {
  try {
    const map = createPhotoMap(result.homography, image);
    const outline = wallPolygonToPx(
      map,
      extentCorners({ minX: 0, maxX: extent.widthMm, minY: 0, maxY: extent.heightMm }),
    );
    return outline === null ? null : outline.map(([x, y]) => [x, y] as const);
  } catch {
    return null;
  }
}

/** `0.0123` -> `1.2%`; the readouts quote relative errors in percent. */
export function percent(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return '∞';
  return `${(fraction * 100).toFixed(digits)}%`;
}
