/**
 * Dragging or turning the board over the photo. A two-point calibration knows the scale but not where the board
 * hangs, so the user lines the grid up with the real wall by hand; the gesture edits only the wall frame of the
 * homography (`transformCalibration`), never the scale or the photo.
 */
import type { Calibration } from '@hsw-editor/core';
import {
  photoMapFromCalibration,
  transformCalibration,
  type BoardExtent,
  type ImageSize,
  type PhotoMap,
  type Vec2,
  type WallFrameChange,
} from '@hsw-editor/overlay';

export type AlignKind = 'move' | 'roll';

/** Cell pitches of the board: a grid-detected photo is calibrated on the real lattice, so moves stay on it. */
export interface Lattice {
  readonly colPitchMm: number;
  readonly rowPitchMm: number;
}

/** A shift of (`col`, `row2`) = whole columns and half rows is a lattice translation when the parities agree. */
function isLatticeShift(col: number, row2: number): boolean {
  return Math.abs(row2 - col) % 2 === 0;
}

/**
 * The lattice translation nearest to (`dxMm`, `dyMm`): whole columns and half rows with the stagger parity (a column
 * step shifts the row by half a pitch), so every board cell lands on a cell of the real wall.
 */
export function snapToLattice(
  dxMm: number,
  dyMm: number,
  lattice: Lattice,
): { readonly dxMm: number; readonly dyMm: number } {
  const halfRow = lattice.rowPitchMm / 2;
  const col = Math.round(dxMm / lattice.colPitchMm);
  const row2 = Math.round(dyMm / halfRow);
  const candidates = (
    [
      [col, row2],
      [col, row2 - 1],
      [col, row2 + 1],
      [col - 1, row2],
      [col + 1, row2],
    ] as const
  ).filter(([c, r]) => isLatticeShift(c, r));
  const distance = ([c, r]: readonly [number, number]): number =>
    (c * lattice.colPitchMm - dxMm) ** 2 + (r * halfRow - dyMm) ** 2;
  const best = candidates.reduce((nearest, candidate) =>
    distance(candidate) < distance(nearest) ? candidate : nearest,
  );
  return { dxMm: best[0] * lattice.colPitchMm, dyMm: best[1] * halfRow };
}

/** The calibration as a stored homography, also for a calibration that only knows a scale. */
export function withHomography(calibration: Calibration, map: PhotoMap): Calibration {
  if (calibration.homography !== undefined) return calibration;
  const h = map.pxToWallMatrix;
  return {
    ...calibration,
    homography: [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]],
  };
}

function foldDegrees(deg: number): number {
  const turn = ((((deg + 180) % 360) + 360) % 360) - 180;
  return turn === -180 ? 180 : turn;
}

/**
 * The calibration after the pointer went from `startPx` to `nowPx`, both in photo pixels: the board point that
 * was under `startPx` follows the pointer. `move` shifts the board, `roll` turns it about its centre.
 */
export function alignCalibration(
  base: Calibration,
  image: ImageSize,
  extent: BoardExtent,
  gesture: { readonly kind: AlignKind; readonly startPx: Vec2; readonly nowPx: Vec2 },
  /** Given for a calibration fitted on the real lattice (grid detector): a move then snaps to whole cells. */
  lattice?: Lattice,
): Calibration | null {
  const map = photoMapFromCalibration(base, image, extent);
  if (map === null) return null;
  const from = map.pxToWall(gesture.startPx);
  const to = map.pxToWall(gesture.nowPx);
  if (from === null || to === null) return null;
  const change: WallFrameChange =
    gesture.kind === 'move'
      ? lattice === undefined
        ? { dxMm: from[0] - to[0], dyMm: from[1] - to[1] }
        : snapToLattice(from[0] - to[0], from[1] - to[1], lattice)
      : rollChange(from, to, extent);
  return transformCalibration(withHomography(base, map), change);
}

function rollChange(from: Vec2, to: Vec2, extent: BoardExtent): WallFrameChange {
  const centre: Vec2 = [extent.widthMm / 2, extent.heightMm / 2];
  const angle = (p: Vec2): number => Math.atan2(p[1] - centre[1], p[0] - centre[0]);
  // Rolling the wall frame by r shows the board turned by -r, so the board follows the pointer with r = -(a1 - a0).
  const rollDeg = foldDegrees((-(angle(to) - angle(from)) * 180) / Math.PI);
  return { rollDeg, about: centre };
}
