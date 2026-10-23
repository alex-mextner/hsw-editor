import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Plane, Vector2, Vector3 } from 'three';
import { itemIdOfHit } from './itemHit.ts';
import { setViewportBridge } from './viewportBridge.ts';

const WALL_PLANE = new Plane(new Vector3(0, 0, 1), 0);

/** Registers the camera/raycaster of the live canvas with the viewport bridge. */
export function BridgeInstaller() {
  const camera = useThree((state) => state.camera);
  const raycaster = useThree((state) => state.raycaster);
  const scene = useThree((state) => state.scene);
  const dom = useThree((state) => state.gl.domElement);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    const ndc = new Vector2();
    const hit = new Vector3();
    const aim = (clientX: number, clientY: number): void => {
      const rect = dom.getBoundingClientRect();
      ndc.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
    };
    setViewportBridge({
      invalidate,
      toWall(clientX, clientY) {
        aim(clientX, clientY);
        if (!raycaster.ray.intersectPlane(WALL_PLANE, hit)) return null;
        return { x: hit.x * 1000, y: hit.y * 1000 };
      },
      itemAt(clientX, clientY) {
        const layers = [scene.getObjectByName('items'), scene.getObjectByName('board')];
        aim(clientX, clientY);
        // The first hit decides: the plate in front of an item (seen from behind) hides it.
        const [nearest] = raycaster.intersectObjects(
          layers.filter((layer) => layer !== undefined),
          true,
        );
        return nearest ? itemIdOfHit(nearest.object.userData, nearest.instanceId) : null;
      },
    });
    return () => setViewportBridge(null);
  }, [camera, raycaster, scene, dom, invalidate]);

  return null;
}
