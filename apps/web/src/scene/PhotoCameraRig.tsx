import { useMemo } from 'react';
import { PerspectiveCamera } from '@react-three/drei';
import { Matrix4, Quaternion } from 'three';
import type { ThreeCamera } from '@hsw-editor/overlay';
import { mm } from './units.ts';

/** The viewport camera of photo mode: fixed where the calibration says the phone was, no orbit controls. */
export function PhotoCameraRig({ camera }: { readonly camera: ThreeCamera }) {
  const quaternion = useMemo(() => {
    const r = camera.rotation;
    const matrix = new Matrix4().set(
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
    return new Quaternion().setFromRotationMatrix(matrix);
  }, [camera.rotation]);
  const [x, y, z] = camera.position;
  return (
    <PerspectiveCamera
      makeDefault
      fov={camera.fovYDeg}
      near={0.02}
      far={60}
      position={[mm(x), mm(y), mm(z)]}
      quaternion={quaternion}
    />
  );
}
