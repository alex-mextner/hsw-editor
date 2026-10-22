import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Plane, Vector2, Vector3 } from 'three';
import { setViewportBridge } from './viewportBridge.ts';

const WALL_PLANE = new Plane(new Vector3(0, 0, 1), 0);

/** Registers the camera/raycaster of the live canvas with the viewport bridge. */
export function BridgeInstaller() {
  const camera = useThree((state) => state.camera);
  const raycaster = useThree((state) => state.raycaster);
  const dom = useThree((state) => state.gl.domElement);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const ndc = new Vector2();
    const hit = new Vector3();
    setViewportBridge({
      invalidate,
      toWall(clientX, clientY) {
        const rect = dom.getBoundingClientRect();
        ndc.set(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(ndc, camera);
        if (!raycaster.ray.intersectPlane(WALL_PLANE, hit)) return null;
        return { x: hit.x * 1000, y: hit.y * 1000 };
      },
    });
    return () => setViewportBridge(null);
  }, [camera, raycaster, dom, invalidate]);

  return null;
}
