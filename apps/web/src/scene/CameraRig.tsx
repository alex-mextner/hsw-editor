import { useEffect, useRef, type ComponentRef } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { MOUSE, OrthographicCamera as ThreeOrthographicCamera, TOUCH, Vector3 } from 'three';
import { mm } from './units.ts';

export type ViewMode = 'perspective' | 'front';

interface CameraRigProps {
  readonly view: ViewMode;
  readonly widthMm: number;
  readonly heightMm: number;
  /** Incremented to re-frame the wall (the "fit" command). */
  readonly fitToken: number;
  /** Disables orbit/pan while an item is being dragged. */
  readonly locked: boolean;
}

/**
 * Perspective orbit camera, or an orthographic front view locked to the wall plane (pan + zoom only).
 * Left button is reserved for selection/drag; right button orbits, middle pans, wheel zooms.
 */
export function CameraRig({ view, widthMm, heightMm, fitToken, locked }: CameraRigProps) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const getState = useThree((state) => state.get);
  const invalidate = useThree((state) => state.invalidate);
  // The active camera object changes when the view mode switches; framing must follow that swap.
  const activeCamera = useThree((state) => state.camera);
  const ortho = view === 'front';

  useEffect(() => {
    const control = controls.current;
    if (!control) return;
    const target = new Vector3(mm(widthMm / 2), mm(heightMm / 2), 0);
    // Read the canvas size at fit time instead of subscribing: a window resize must not re-frame the view.
    const { size } = getState();
    const aspect = size.width / Math.max(size.height, 1);
    const camera = control.object;
    if (camera instanceof ThreeOrthographicCamera) {
      // Fit the wall (+12% margin) in the orthographic frustum, 1 world unit == `zoom` pixels.
      const fitZoom = Math.min(
        size.width / (mm(widthMm) * 1.12),
        size.height / (mm(heightMm) * 1.12),
      );
      camera.position.set(target.x, target.y, 5);
      camera.zoom = fitZoom;
      camera.updateProjectionMatrix();
    } else {
      const fov = 40;
      const distance = Math.max(
        (mm(heightMm) * 0.62) / Math.tan((fov * Math.PI) / 360),
        (mm(widthMm) * 0.62) / (Math.tan((fov * Math.PI) / 360) * aspect),
      );
      camera.position.set(target.x, target.y - distance * 0.12, distance);
    }
    control.target.copy(target);
    control.update();
    invalidate();
  }, [view, widthMm, heightMm, fitToken, activeCamera, getState, invalidate]);

  return (
    <>
      <PerspectiveCamera
        makeDefault={!ortho}
        position={[0.6, 0.5, 2]}
        fov={40}
        near={0.05}
        far={60}
      />
      <OrthographicCamera
        makeDefault={ortho}
        position={[0.6, 0.4, 5]}
        near={0.05}
        far={60}
        zoom={400}
      />
      <OrbitControls
        ref={controls}
        makeDefault
        enabled={!locked}
        enableRotate={!ortho}
        enableDamping={false}
        screenSpacePanning
        zoomToCursor
        minDistance={0.15}
        maxDistance={20}
        maxPolarAngle={Math.PI * 0.62}
        mouseButtons={{
          LEFT: undefined as unknown as MOUSE,
          MIDDLE: MOUSE.PAN,
          RIGHT: ortho ? MOUSE.PAN : MOUSE.ROTATE,
        }}
        touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
      />
    </>
  );
}
