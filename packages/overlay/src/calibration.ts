/**
 * Photo calibration: how a photo of a real wall becomes metric.
 *
 *  - two-point: two clicks along a reference of known length (tape measure, ruler) -> uniform mm/px. Exact
 *    for a fronto-parallel photo; for a tilted one it is the scale along the reference at that location.
 *  - corners: 4 clicks on the corners of a rectangle of known size (the wall, a board) -> full homography,
 *    so camera tilt is rectified away.
 *  - correspondences: any 4+ photo<->wall point pairs (e.g. honeycomb cell centres) -> least-squares homography.
 *
 * Every result is a plain photo->wall homography plus the correspondences that produced it, serialisable as
 * the `Calibration` of `@hsw-editor/core` (one `setCalibration` op, undoable).
 */
import {
  boardSizeMm,
  cellCenter,
  MAX_CALIBRATION_POINTS,
  type Board,
  type Calibration,
  type GridCell,
} from '@hsw-editor/core';
import { DegenerateError, mul3, rotation, translation, type Mat3, type Vec2 } from './matrix.ts';
import {
  fitHomography,
  isConvexOrdered,
  projectOrThrow,
  reprojectionReport,
  signedArea,
  type Correspondence,
  type ReprojectionReport,
} from './homography.ts';
import { reliableFocalPx } from './camera.ts';
import {
  createPhotoMap,
  transformWallFrame,
  type ImageSize,
  type PhotoMap,
  type WallFrameChange,
} from './photo-map.ts';

/** A 1 m tape: the default length offered in the wizard. */
export const DEFAULT_REFERENCE_MM = 1000;
/** Two clicks closer than this cannot define a scale. */
const MIN_REFERENCE_PX = 4;

/** How the reference is laid out on the wall; lets the wizard also fix the camera roll. */
export type ReferenceAxis = 'free' | 'horizontal' | 'vertical';

export interface ReferenceMeasurement {
  /** Photo px of the two ends of the reference. */
  a: Vec2;
  b: Vec2;
  /** Real length between the two clicked points. */
  realMm: number;
  /** `free` keeps the photo's up as the wall's up. */
  axis?: ReferenceAxis;
}

export type CalibrationMethod = Calibration['method'];

export interface CalibrationResult {
  method: CalibrationMethod;
  /** Photo px -> wall mm. */
  homography: Mat3;
  /** Local scale at the photo centre. */
  mmPerPx: number;
  focalPx?: number;
  reprojection: ReprojectionReport;
  points: Correspondence[];
}

export function referenceLengthPx(m: Pick<ReferenceMeasurement, 'a' | 'b'>): number {
  return Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]);
}

function checkReference(m: ReferenceMeasurement): number {
  if (!Number.isFinite(m.realMm) || m.realMm <= 0) {
    throw new DegenerateError('the reference length must be a positive number of millimetres');
  }
  const px = referenceLengthPx(m);
  if (!(px >= MIN_REFERENCE_PX)) {
    throw new DegenerateError(`the two reference clicks are only ${px.toFixed(1)} px apart`);
  }
  return px;
}

/** Millimetres per photo pixel implied by the reference. */
export function scaleFromReference(m: ReferenceMeasurement): number {
  return m.realMm / checkReference(m);
}

export interface ScaleErrorBound {
  /** Length of the reference in the photo. */
  referencePx: number;
  clickErrorPx: number;
  /** Worst case: both clicks off by `clickErrorPx` along the reference, towards each other (L / (L - 2e) - 1). */
  worstRelativeError: number;
  /** Typical (1 sigma) with independent errors of `clickErrorPx` per click: sqrt(2) * e / L. */
  typicalRelativeError: number;
  /** Worst-case error accumulated over one metre of the wall. */
  worstMmPerMeter: number;
  typicalMmPerMeter: number;
}

/** What a click error of `clickErrorPx` per endpoint does to the scale: shown to the user next to the result. */
export function scaleErrorBound(m: ReferenceMeasurement, clickErrorPx: number): ScaleErrorBound {
  const referencePx = checkReference(m);
  const worst =
    referencePx > 2 * clickErrorPx ? referencePx / (referencePx - 2 * clickErrorPx) - 1 : Infinity;
  const typical = (Math.SQRT2 * clickErrorPx) / referencePx;
  return {
    referencePx,
    clickErrorPx,
    worstRelativeError: worst,
    typicalRelativeError: typical,
    worstMmPerMeter: worst * 1000,
    typicalMmPerMeter: typical * 1000,
  };
}

/** Maps an angle in degrees into (-90, 90]: a reference has no direction, only an axis. */
function foldHalfTurn(deg: number): number {
  let d = deg % 180;
  if (d > 90) d -= 180;
  if (d <= -90) d += 180;
  return d;
}

export interface BoardExtent {
  widthMm: number;
  heightMm: number;
}

export function boardExtent(board: Board): BoardExtent {
  const size = boardSizeMm(board);
  return { widthMm: size.width, heightMm: size.height };
}

/**
 * Two-point calibration. The board is placed so that its centre sits under the photo centre (the user then
 * drags it into place); `axis` additionally rolls the wall so the reference lies exactly horizontal or vertical.
 * The two reference points are stored as correspondences: they reproduce the typed length exactly.
 */
export function calibrateTwoPoint(
  m: ReferenceMeasurement,
  image: ImageSize,
  extent: BoardExtent,
): CalibrationResult {
  const s = scaleFromReference(m);
  let rollDeg = 0;
  const axis = m.axis ?? 'free';
  if (axis !== 'free') {
    // Direction of the reference in wall-like coordinates (y up), before any roll.
    const phi = (Math.atan2(-(m.b[1] - m.a[1]), m.b[0] - m.a[0]) * 180) / Math.PI;
    rollDeg = foldHalfTurn((axis === 'horizontal' ? 0 : 90) - phi);
  }
  const homography = similarityHomography(s, rollDeg, image, extent);
  const points = [m.a, m.b].map((px) => ({ px, wall: projectOrThrow(homography, px) }));
  return {
    method: 'two-point',
    homography,
    mmPerPx: s,
    reprojection: reprojectionReport(homography, points),
    points,
  };
}

/** wall = T(board centre) * R(roll) * diag(s, -s) * T(-photo centre): photo y points down, wall y up. */
function similarityHomography(
  s: number,
  rollDeg: number,
  image: ImageSize,
  extent: BoardExtent,
): Mat3 {
  const flipScale: Mat3 = [s, 0, 0, 0, -s, 0, 0, 0, 1];
  return mul3(
    translation(extent.widthMm / 2, extent.heightMm / 2),
    mul3(rotation(rollDeg), mul3(flipScale, translation(-image.width / 2, -image.height / 2))),
  );
}

/** Wall corner order the wizard asks for: lower-left, lower-right, upper-right, upper-left (as seen from the room). */
export const CORNER_ORDER = ['lower-left', 'lower-right', 'upper-right', 'upper-left'] as const;

export class CornerOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CornerOrderError';
  }
}

export interface CornersInput {
  /** Photo px of [lower-left, lower-right, upper-right, upper-left]. */
  cornersPx: readonly [Vec2, Vec2, Vec2, Vec2];
  /** Real size of the rectangle the corners span. */
  widthMm: number;
  heightMm: number;
}

/**
 * Four-corner rectification. The corners are given in wall order (see `CORNER_ORDER`); the rectangle's lower-left
 * becomes the wall origin. Throws `CornerOrderError` when the clicks are not a convex quadrilateral in the
 * expected (clockwise on screen) order, so a swapped pair is reported instead of fitting a mirrored plane.
 */
export function calibrateFromCorners(input: CornersInput, image: ImageSize): CalibrationResult {
  const { widthMm, heightMm, cornersPx } = input;
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new DegenerateError('the rectangle size must be positive');
  }
  if (!isConvexOrdered(cornersPx)) {
    throw new CornerOrderError(
      'the four corners do not form a convex quadrilateral: click lower-left, lower-right, upper-right, upper-left',
    );
  }
  // Photo y points down, so lower-left -> lower-right -> upper-right -> upper-left runs clockwise (negative area).
  if (signedArea(cornersPx) >= 0) {
    throw new CornerOrderError(
      'the corners run the wrong way round: click lower-left, lower-right, upper-right, upper-left as seen from the room',
    );
  }
  requireUprightStart(cornersPx);
  const wallCorners: Vec2[] = [
    [0, 0],
    [widthMm, 0],
    [widthMm, heightMm],
    [0, heightMm],
  ];
  const pairs = cornersPx.map((px, i) => ({ px, wall: wallCorners[i]! }));
  return calibrateFromCorrespondences(pairs, image, 'manual');
}

/**
 * The convex, clockwise check cannot tell which corner the user started at: clicking [upper-left, lower-left, ...]
 * passes it and silently turns the wall by 90 degrees. Photos are upright (EXIF applied at intake), so the bottom
 * edge must point right and the left edge up in the photo, each within 45 degrees.
 */
function requireUprightStart(corners: readonly [Vec2, Vec2, Vec2, Vec2]): void {
  const [lowerLeft, lowerRight, , upperLeft] = corners;
  const bottom: Vec2 = [lowerRight[0] - lowerLeft[0], lowerRight[1] - lowerLeft[1]];
  const left: Vec2 = [upperLeft[0] - lowerLeft[0], upperLeft[1] - lowerLeft[1]];
  const bottomPointsRight = bottom[0] > 0 && bottom[0] >= Math.abs(bottom[1]);
  const leftPointsUp = left[1] < 0 && -left[1] >= Math.abs(left[0]);
  if (!bottomPointsRight || !leftPointsUp) {
    throw new CornerOrderError(
      'start at the lower-left corner: the bottom edge must run to the right and the left edge upwards in the photo',
    );
  }
}

/**
 * Least-squares calibration from 4+ photo<->wall pairs (honeycomb cell centres, measured marks). Also rejects a plane
 * whose horizon crosses the photo, and a fit whose scale is not a finite positive number.
 */
export function calibrateFromCorrespondences(
  pairs: readonly Correspondence[],
  image: ImageSize,
  method: Extract<CalibrationMethod, 'grid' | 'manual' | 'vision'> = 'grid',
): CalibrationResult {
  const homography = fitHomography(pairs);
  const map = createPhotoMap(homography, image);
  if (!(map.centerScaleMmPerPx > 0) || !Number.isFinite(map.centerScaleMmPerPx)) {
    throw new DegenerateError('the points define no usable scale');
  }
  const reprojection = reprojectionReport(homography, pairs, map.wallToPxMatrix);
  const focalPx = reliableFocalPx(map.wallToPxMatrix, image);
  return {
    method,
    homography,
    mmPerPx: map.centerScaleMmPerPx,
    ...(focalPx === undefined ? {} : { focalPx }),
    reprojection,
    points: [...pairs],
  };
}

/** Photo clicks on honeycomb cell centres whose (col, row) the user or the vision service named. */
export function cellCorrespondences(
  board: Board,
  clicks: readonly { px: Vec2; cell: GridCell }[],
): Correspondence[] {
  return clicks.map((click) => {
    const c = cellCenter(board, click.cell);
    return { px: click.px, wall: [c.x, c.y] };
  });
}

/**
 * Serialises a result as the `Calibration` stored on the photo (the payload of `setCalibration`). The homography
 * is always stored in full; when a grid fit used more than `MAX_CALIBRATION_POINTS` cells, an evenly spaced subset of
 * the correspondences is kept as the record of the fit.
 */
export function toCoreCalibration(result: CalibrationResult): Calibration {
  const { rmsPx } = result.reprojection;
  if (!Number.isFinite(rmsPx)) {
    throw new DegenerateError('the calibration does not reproject its own points');
  }
  const h = result.homography;
  const total = result.points.length;
  const kept =
    total <= MAX_CALIBRATION_POINTS
      ? result.points
      : Array.from(
          { length: MAX_CALIBRATION_POINTS },
          (_, i) => result.points[Math.floor((i * total) / MAX_CALIBRATION_POINTS)]!,
        );
  return {
    method: result.method,
    mmPerPx: result.mmPerPx,
    homography: [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]],
    ...(result.focalPx === undefined ? {} : { focalPx: result.focalPx }),
    reprojErrorPx: rmsPx,
    points: kept.map((p) => ({ px: [p.px[0], p.px[1]], wall: [p.wall[0], p.wall[1]] })),
  };
}

/**
 * Rebuilds the photo map from a stored calibration. A calibration with only `mmPerPx` (e.g. from the vision
 * service) becomes a fronto-parallel map with the board centred under the photo centre. Returns null when the
 * calibration is unusable (no scale at all, or a stored matrix that is singular or whose horizon crosses the
 * photo: corrupt or foreign data), so the UI can ask for a fresh calibration instead of failing to load.
 */
export function photoMapFromCalibration(
  calibration: Calibration,
  image: ImageSize,
  extent: BoardExtent,
): PhotoMap | null {
  try {
    if (calibration.homography !== undefined) return createPhotoMap(calibration.homography, image);
    if (calibration.mmPerPx === undefined) return null;
    return createPhotoMap(similarityHomography(calibration.mmPerPx, 0, image, extent), image);
  } catch (error) {
    if (error instanceof DegenerateError) return null;
    throw error;
  }
}

/**
 * Moves or rolls the board under the photo (the drag of a two-point calibration) and returns the calibration to store.
 * The stored correspondences move with the wall frame so they keep describing the same clicks, and the scale and the
 * reprojection error are unchanged. Null for a calibration that has no homography to edit.
 */
export function transformCalibration(
  calibration: Calibration,
  change: WallFrameChange,
): Calibration | null {
  const h = calibration.homography;
  if (h === undefined) return null;
  const moved = transformWallFrame(h, change);
  // The same change applied to the wall points (as a map of the wall plane onto itself).
  const frame = transformWallFrame([1, 0, 0, 0, 1, 0, 0, 0, 1], change);
  const points = calibration.points?.map((p) => {
    const wall = projectOrThrow(frame, p.wall);
    return { px: p.px, wall: [wall[0], wall[1]] satisfies [number, number] };
  });
  return {
    ...calibration,
    homography: [
      moved[0],
      moved[1],
      moved[2],
      moved[3],
      moved[4],
      moved[5],
      moved[6],
      moved[7],
      moved[8],
    ],
    ...(points === undefined ? {} : { points }),
  };
}
