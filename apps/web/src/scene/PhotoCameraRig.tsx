import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { buildPhotoCamera } from './photoCamera3.ts';
import type { PhotoCamera } from '@hsw-editor/overlay';
import type { exactProjection } from './photoProjection.ts';

/**
 * The viewport camera of photo mode: fixed where the calibration says the phone was, no orbit controls, and a
 * projection that puts the wall plane on exactly the pixels of the calibration.
 */
export function PhotoCameraRig({
  camera,
  wallToPx,
  image,
}: {
  readonly camera: PhotoCamera;
  readonly wallToPx: Parameters<typeof exactProjection>[0];
  readonly image: { readonly width: number; readonly height: number };
}) {
  const set = useThree((state) => state.set);
  const get = useThree((state) => state.get);
  const invalidate = useThree((state) => state.invalidate);
  const built = useMemo(() => buildPhotoCamera(camera, wallToPx, image), [camera, wallToPx, image]);
  useEffect(() => {
    const before = get().camera;
    set({ camera: built });
    invalidate();
    return () => {
      set({ camera: before });
      invalidate();
    };
  }, [built, get, set, invalidate]);
  return null;
}
