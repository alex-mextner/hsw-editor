/**
 * The camera that looks at the wall the way the photo does, for the camera-matched 3D view. The photo itself is
 * drawn on the wall plane through the calibration homography, so photo, grid and items always agree on that
 * plane; this camera only adds the right perspective for things that stand off the wall.
 */
import {
  cameraFromHomography,
  defaultFocalPx,
  reliableFocalPx,
  threeCameraFromPose,
  type CameraPose,
  type ThreeCamera,
} from './camera.ts';
import type { PhotoMap } from './photo-map.ts';

/** Where the focal length came from: a stored calibration, the homography's own geometry, or the phone default. */
export type FocalSource = 'stored' | 'estimated' | 'assumed';

export interface PhotoCamera {
  pose: CameraPose;
  three: ThreeCamera;
  focalSource: FocalSource;
}

export interface PhotoCameraOptions {
  /** `Calibration.focalPx` of the photo, when it has one. */
  storedFocalPx?: number | undefined;
  /** EXIF FocalLengthIn35mmFilm, when known; the assumed focal length uses it. */
  focal35mm?: number | undefined;
}

export function photoCamera(map: PhotoMap, options: PhotoCameraOptions = {}): PhotoCamera | null {
  let focalPx: number;
  let focalSource: FocalSource;
  const estimated =
    options.storedFocalPx !== undefined && options.storedFocalPx > 0
      ? undefined
      : reliableFocalPx(map.wallToPxMatrix, map.image);
  if (options.storedFocalPx !== undefined && options.storedFocalPx > 0) {
    focalPx = options.storedFocalPx;
    focalSource = 'stored';
  } else if (estimated !== undefined) {
    focalPx = estimated;
    focalSource = 'estimated';
  } else {
    focalPx = defaultFocalPx(map.image, options.focal35mm);
    focalSource = 'assumed';
  }
  const pose = cameraFromHomography(map.wallToPxMatrix, map.image, focalPx);
  if (pose === null) return null;
  return { pose, three: threeCameraFromPose(pose, map.image), focalSource };
}
