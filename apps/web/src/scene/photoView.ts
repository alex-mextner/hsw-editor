/**
 * What photo mode shows for one wall photo: the calibration turned into a wall<->photo map and into the
 * three.js camera that sees the wall the way the photo does. Pure; the viewport only renders the result.
 */
import type { Calibration, Photo, Wall } from '@hsw-editor/core';
import {
  boardExtent,
  photoCamera,
  photoMapFromCalibration,
  type ImageSize,
  type PhotoCamera,
  type PhotoMap,
} from '@hsw-editor/overlay';

export interface PhotoView {
  readonly photo: Photo;
  /** The cleaned variant of `photo` (the wall without what hangs there now), when one has been made. */
  readonly clean: Photo | null;
  readonly calibration: Calibration;
  readonly image: ImageSize;
  readonly map: PhotoMap;
  readonly camera: PhotoCamera;
}

export type PhotoViewState =
  /** Photo mode is off, or the photo is gone from the wall. */
  | { readonly status: 'off' }
  /** The photo has no calibration yet: only the wizard can show it. */
  | { readonly status: 'uncalibrated'; readonly photo: Photo }
  /** A stored calibration that cannot be shown (singular matrix, horizon inside the photo, no camera). */
  | { readonly status: 'unusable'; readonly photo: Photo }
  | { readonly status: 'ready'; readonly view: PhotoView };

/** `draft` replaces the stored calibration while the board is being moved over the photo. */
export function photoViewState(
  wall: Wall,
  photoId: string | null,
  draft: Calibration | null,
): PhotoViewState {
  const photo = photoId === null ? undefined : wall.photos.find((entry) => entry.id === photoId);
  if (!photo) return { status: 'off' };
  const calibration = draft ?? photo.calibration;
  if (!calibration) return { status: 'uncalibrated', photo };
  const image = { width: photo.width, height: photo.height };
  const map = photoMapFromCalibration(calibration, image, boardExtent(wall.board));
  if (map === null) return { status: 'unusable', photo };
  const camera = photoCamera(map, { storedFocalPx: calibration.focalPx });
  if (camera === null) return { status: 'unusable', photo };
  const clean = wall.photos.find((entry) => entry.cleanOf === photo.id) ?? null;
  return { status: 'ready', view: { photo, clean, calibration, image, map, camera } };
}

/** The photo whose pixels the viewport shows: the cleaned variant when it exists and is wanted, else the original. */
export function shownPhoto(view: Pick<PhotoView, 'photo' | 'clean'>, wantCleaned: boolean): Photo {
  return wantCleaned && view.clean !== null ? view.clean : view.photo;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The largest box of the photo's aspect ratio that fits the container, centred. */
export function fitBox(container: { width: number; height: number }, image: ImageSize): Box {
  const scale = Math.min(container.width / image.width, container.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    left: (container.width - width) / 2,
    top: (container.height - height) / 2,
    width,
    height,
  };
}
