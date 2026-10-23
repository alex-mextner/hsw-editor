import { Matrix4, PerspectiveCamera } from 'three';
import type { PhotoCamera } from '@hsw-editor/overlay';
import { exactProjection } from './photoProjection.ts';
import { mm } from './units.ts';

/** A camera whose projection is fixed by the calibration, not by the canvas size. */
export function buildPhotoCamera(
  photo: PhotoCamera,
  wallToPx: Parameters<typeof exactProjection>[0],
  image: {
    readonly width: number;
    readonly height: number;
  },
): PerspectiveCamera {
  const camera = new PerspectiveCamera(photo.three.fovYDeg, image.width / image.height, 0.02, 60);
  const r = photo.three.rotation;
  const rotation = new Matrix4().set(
    r[0],
    r[1],
    r[2],
    0,
    r[3],
    r[4],
    r[5],
    0,
    r[6],
    r[7],
    r[8],
    0,
    0,
    0,
    0,
    1,
  );
  const exact = exactProjection(wallToPx, photo.pose, image);
  // Rays must start where the projection's own rays meet, not at the pose recovered from the same matrix.
  if (exact) camera.position.set(...exact.centre);
  else
    camera.position.set(
      mm(photo.three.position[0]),
      mm(photo.three.position[1]),
      mm(photo.three.position[2]),
    );
  camera.quaternion.setFromRotationMatrix(rotation);
  camera.updateMatrixWorld(true);
  if (exact) {
    // clip = P * viewInverse * world, and the engine multiplies projection * matrixWorldInverse.
    const clip = new Matrix4().set(
      ...(exact.clip.flat() as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ]),
    );
    camera.projectionMatrix.copy(clip).multiply(camera.matrixWorld);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    // The canvas must not recompute it from its own aspect ratio.
    camera.updateProjectionMatrix = () => undefined;
    Object.assign(camera, { manual: true });
  }
  return camera;
}
