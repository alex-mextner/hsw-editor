/** Pure helpers between the overlay wizard state machine and the calibration panel. */
import {
  createPhotoMap,
  extentCorners,
  wallPolygonToPx,
  type BoardExtent,
  type CalibrationResult,
  type ImageSize,
  type ScaleErrorBound,
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

/** What `photo.wizard.clickError` shows: the scale error of a 1 px and of a 3 px click error, in % and in mm per metre. */
export function clickErrorParams(
  clickError: { readonly onePx: ScaleErrorBound; readonly threePx: ScaleErrorBound },
  formatMm: (mm: number) => string,
): Record<'typical' | 'worst' | 'mm' | 'three' | 'threeWorst' | 'threeMm', string> {
  return {
    typical: percent(clickError.onePx.typicalRelativeError),
    worst: percent(clickError.onePx.worstRelativeError),
    mm: formatMm(clickError.onePx.worstMmPerMeter),
    three: percent(clickError.threePx.typicalRelativeError),
    threeWorst: percent(clickError.threePx.worstRelativeError),
    threeMm: formatMm(clickError.threePx.worstMmPerMeter),
  };
}
