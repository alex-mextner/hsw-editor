/**
 * Photo <-> wall mapping: a calibrated photo is a homography from photo pixels to wall millimetres. This is
 * the single place that converts between the two spaces, in both directions, for points, directions and
 * local scale, so dragging, rulers and export all agree.
 */
import {
  DegenerateError,
  inv3,
  mul3,
  rotation,
  translation,
  type Mat3,
  type Vec2,
} from './matrix.ts';
import { project } from './homography.ts';

export interface ImageSize {
  width: number;
  height: number;
}

export interface PhotoMap {
  readonly image: ImageSize;
  /** Photo px -> wall mm. */
  readonly pxToWallMatrix: Mat3;
  /** Wall mm -> photo px. */
  readonly wallToPxMatrix: Mat3;
  /** Null when the point lies beyond the plane's horizon (only possible far outside the photo). */
  pxToWall(px: Vec2): Vec2 | null;
  /** Null for wall points behind the camera (beyond the plane's vanishing line), where the pixel would be mirrored. */
  wallToPx(wall: Vec2): Vec2 | null;
  /** Millimetres per pixel at a photo point (geometric mean over directions: sqrt|det J|). */
  localScaleMmPerPx(px: Vec2): number;
  /** Millimetres per pixel at a photo point along a photo-space direction. */
  directionalScaleMmPerPx(px: Vec2, direction: Vec2): number;
  /** Local scale at the photo centre: the single "mm per px" figure shown in the UI. */
  readonly centerScaleMmPerPx: number;
}

function jacobian(h: Mat3, p: Vec2): readonly [number, number, number, number] | null {
  const w = h[6] * p[0] + h[7] * p[1] + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-12) return null;
  const n1 = h[0] * p[0] + h[1] * p[1] + h[2];
  const n2 = h[3] * p[0] + h[4] * p[1] + h[5];
  const w2 = w * w;
  return [
    (h[0] * w - n1 * h[6]) / w2,
    (h[1] * w - n1 * h[7]) / w2,
    (h[3] * w - n2 * h[6]) / w2,
    (h[4] * w - n2 * h[7]) / w2,
  ];
}

function wOf(h: Mat3, p: Vec2): number {
  return h[6] * p[0] + h[7] * p[1] + h[8];
}

/**
 * Builds the map and validates that the plane stays on one side of its horizon over the whole photo (a
 * calibration whose horizon crosses the image would mirror part of the wall). Throws `DegenerateError`.
 */
export function createPhotoMap(pxToWall: Mat3, image: ImageSize): PhotoMap {
  const wallToPx = inv3(pxToWall);
  const corners: Vec2[] = [
    [0, 0],
    [image.width, 0],
    [image.width, image.height],
    [0, image.height],
    [image.width / 2, image.height / 2],
  ];
  const reference = Math.sign(wOf(pxToWall, corners[4]!));
  for (const corner of corners) {
    if (Math.sign(wOf(pxToWall, corner)) !== reference || reference === 0) {
      throw new DegenerateError(
        'the wall plane horizon crosses the photo; re-check the clicked points',
      );
    }
  }
  const localScale = (px: Vec2): number => {
    const j = jacobian(pxToWall, px);
    return j === null ? NaN : Math.sqrt(Math.abs(j[0] * j[3] - j[1] * j[2]));
  };
  return {
    image,
    pxToWallMatrix: pxToWall,
    wallToPxMatrix: wallToPx,
    pxToWall: (px) => (Math.sign(wOf(pxToWall, px)) === reference ? project(pxToWall, px) : null),
    // The third component of H^-1 [W, 1] is 1 / w of the photo point, so the same sign test applies.
    wallToPx: (wall) =>
      Math.sign(wOf(wallToPx, wall)) === reference ? project(wallToPx, wall) : null,
    localScaleMmPerPx: localScale,
    directionalScaleMmPerPx: (px, direction) => {
      const j = jacobian(pxToWall, px);
      const length = Math.hypot(direction[0], direction[1]);
      if (j === null || length === 0) return NaN;
      const dx = direction[0] / length;
      const dy = direction[1] / length;
      return Math.hypot(j[0] * dx + j[1] * dy, j[2] * dx + j[3] * dy);
    },
    centerScaleMmPerPx: localScale([image.width / 2, image.height / 2]),
  };
}

/**
 * Re-positions the board under the photo: shifts the wall frame by `(dxMm, dyMm)` and/or rotates it by `rollDeg`
 * about the wall point `about`. Used when dragging or turning the board over a two-point (scale-only)
 * calibration; the scale and the photo are untouched.
 */
export interface WallFrameChange {
  dxMm?: number;
  dyMm?: number;
  rollDeg?: number;
  about?: Vec2;
}

export function transformWallFrame(pxToWall: Mat3, change: WallFrameChange): Mat3 {
  let h = pxToWall;
  if (change.rollDeg !== undefined && change.rollDeg !== 0) {
    const [ax, ay] = change.about ?? [0, 0];
    h = mul3(mul3(translation(ax, ay), mul3(rotation(change.rollDeg), translation(-ax, -ay))), h);
  }
  if (change.dxMm !== undefined || change.dyMm !== undefined) {
    h = mul3(translation(change.dxMm ?? 0, change.dyMm ?? 0), h);
  }
  return h;
}

export interface ScaleSpread {
  minMmPerPx: number;
  maxMmPerPx: number;
  /** max / min - 1: 0.1 means the scale differs by 10% between the nearest and the farthest part of the photo. */
  relativeSpread: number;
}

/**
 * How much the mm-per-pixel scale varies over the photo (sampled on a grid). A tilted wall photographed from
 * close by varies a lot; a single two-point scale is then only valid near the reference, and the UI warns.
 */
export function scaleSpread(map: PhotoMap, samples = 5): ScaleSpread {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const px: Vec2 = [
        (map.image.width * (i + 0.5)) / samples,
        (map.image.height * (j + 0.5)) / samples,
      ];
      const s = map.localScaleMmPerPx(px);
      if (Number.isFinite(s)) {
        min = Math.min(min, s);
        max = Math.max(max, s);
      }
    }
  }
  return { minMmPerPx: min, maxMmPerPx: max, relativeSpread: max / min - 1 };
}
