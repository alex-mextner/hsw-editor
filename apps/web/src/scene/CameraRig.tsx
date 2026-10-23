import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { OrthographicCamera as ThreeOrthographicCamera, Vector3 } from 'three';
import { isTypingTarget } from '@/commands/typing.ts';
import { editorStore } from '@/state/editor.ts';
import { bindCameraLock, mouseButtonsFor, touchesFor } from './cameraControls.ts';
import { mm } from './units.ts';
import type { Extent } from './wallExtent.ts';

export type ViewMode = 'perspective' | 'front';

interface CameraRigProps {
  readonly view: ViewMode;
  /** What the view frames: the board and whatever overhangs it (`wallExtent`). Read when framing, so an edit never re-frames. */
  readonly extent: Extent;
  /** Something overhangs the board: the view frames again when this turns on (the tools' boxes only exist once their models are known). */
  readonly overhangs: boolean;
  readonly widthMm: number;
  readonly heightMm: number;
  /** Incremented to re-frame the wall (the "fit" command). */
  readonly fitToken: number;
}

/** True while Space is held outside a text field or button: left drag pans instead of orbiting. */
function useSpacePan(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const press = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      // Space on a focused button/menu item activates it; it must not also switch the camera mode.
      if (event.target instanceof Element && event.target.closest('button, a, [role]')) return;
      setHeld(true);
    };
    const release = (event: KeyboardEvent): void => {
      if (event.code === 'Space') setHeld(false);
    };
    const reset = (): void => setHeld(false);
    globalThis.addEventListener('keydown', press);
    globalThis.addEventListener('keyup', release);
    globalThis.addEventListener('blur', reset);
    return () => {
      globalThis.removeEventListener('keydown', press);
      globalThis.removeEventListener('keyup', release);
      globalThis.removeEventListener('blur', reset);
    };
  }, []);
  return held;
}

/**
 * Perspective orbit camera, or an orthographic front view locked to the wall plane (pan + zoom only).
 * Left drag on the background orbits (pans in the front view; Shift or Space switches to pan), middle
 * drag pans, the wheel zooms, the right button belongs to the context menu. Dragging an item never
 * moves the camera: the controls are switched off while an item is held or a non-select tool is
 * active (see `bindCameraLock`).
 */
export function CameraRig({
  view,
  extent,
  overhangs,
  widthMm,
  heightMm,
  fitToken,
}: CameraRigProps) {
  const extentRef = useRef(extent);
  useEffect(() => {
    extentRef.current = extent;
  });
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const getState = useThree((state) => state.get);
  const invalidate = useThree((state) => state.invalidate);
  // The active camera object changes when the view mode switches; framing must follow that swap.
  const activeCamera = useThree((state) => state.camera);
  const ortho = view === 'front';
  const panHeld = useSpacePan();
  const mouseButtons = useMemo(() => mouseButtonsFor({ ortho, panHeld }), [ortho, panHeld]);
  const touches = useMemo(() => touchesFor({ ortho }), [ortho]);

  // OrbitControls is re-created when the active camera changes; the lock must follow the new instance.
  useEffect(() => {
    const control = controls.current;
    return control ? bindCameraLock(control, editorStore) : undefined;
  }, [activeCamera]);

  // The view frames again for overhang once per framing: later edits that put a tool over the edge or take it back never move it.
  const framing = useRef<{ key: string; camera: unknown; overhangFramed: boolean } | null>(null);

  useEffect(() => {
    const control = controls.current;
    if (!control) return;
    const key = `${view}|${widthMm}|${heightMm}|${fitToken}`;
    const last = framing.current;
    const sameFraming = last?.key === key && last.camera === activeCamera;
    if (sameFraming && (!overhangs || last.overhangFramed)) return;
    framing.current = { key, camera: activeCamera, overhangFramed: sameFraming || overhangs };
    const framed = extentRef.current;
    const frameWidth = Math.max(widthMm, framed.x1 - framed.x0);
    const frameHeight = Math.max(heightMm, framed.y1 - framed.y0);
    const target = new Vector3(mm((framed.x0 + framed.x1) / 2), mm((framed.y0 + framed.y1) / 2), 0);
    // Read the canvas size at fit time instead of subscribing: a window resize must not re-frame the view.
    const { size } = getState();
    const aspect = size.width / Math.max(size.height, 1);
    const camera = control.object;
    if (camera instanceof ThreeOrthographicCamera) {
      // Fit the wall (+12% margin) in the orthographic frustum, 1 world unit == `zoom` pixels.
      const fitZoom = Math.min(
        size.width / (mm(frameWidth) * 1.12),
        size.height / (mm(frameHeight) * 1.12),
      );
      camera.position.set(target.x, target.y, 5);
      camera.zoom = fitZoom;
      camera.updateProjectionMatrix();
    } else {
      const fov = 40;
      const distance = Math.max(
        (mm(frameHeight) * 0.62) / Math.tan((fov * Math.PI) / 360),
        (mm(frameWidth) * 0.62) / (Math.tan((fov * Math.PI) / 360) * aspect),
      );
      camera.position.set(target.x, target.y - distance * 0.12, distance);
    }
    control.target.copy(target);
    control.update();
    invalidate();
  }, [view, widthMm, heightMm, fitToken, overhangs, activeCamera, getState, invalidate]);

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
        enableRotate={!ortho}
        enableDamping={false}
        screenSpacePanning
        zoomToCursor
        minDistance={0.15}
        maxDistance={20}
        maxPolarAngle={Math.PI * 0.62}
        mouseButtons={mouseButtons}
        touches={touches}
      />
    </>
  );
}
