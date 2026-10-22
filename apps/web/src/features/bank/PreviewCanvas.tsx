import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import type { Group } from 'three';
import type { BankElement } from '@hsw-editor/bank';
import { bankRoutes } from '@/bank/client.ts';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { MM } from '@/scene/units.ts';
import { frameModel, PREVIEW_FOV_DEG, type PreviewFrame } from './framing.ts';

const SPIN_RAD_PER_SECOND = 0.9;

interface ModelProps {
  readonly url: string;
  readonly frame: PreviewFrame;
  /** Spin the model itself (hover preview); the detail view orbits the camera instead. */
  readonly spin: boolean;
  readonly onLoaded: () => void;
}

function Model({ url, frame, spin, onLoaded }: ModelProps) {
  const gltf = useGLTF(url);
  // The scene graph belongs to drei's cache (shared with the wall's instanced meshes); a clone keeps
  // our transforms off it. Geometry and materials stay shared, so nothing here may dispose them.
  const model = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const spinner = useRef<Group>(null);
  useFrame((_, delta) => {
    if (spin && spinner.current) spinner.current.rotation.y += delta * SPIN_RAD_PER_SECOND;
  });
  useEffect(onLoaded, [model, onLoaded]);
  const { x, y, z } = frame.centreMm;
  return (
    <group ref={spinner}>
      <group position={[-x * MM, -y * MM, -z * MM]}>
        <primitive object={model} scale={MM} />
      </group>
    </group>
  );
}

interface PreviewCanvasProps {
  readonly element: BankElement;
  readonly mode: 'hover' | 'orbit';
  readonly onLoaded: () => void;
}

/**
 * The one WebGL preview of a bank element (lod1 GLB, bank mm frame, no rotation needed). Callers
 * must hold the preview slot before mounting it.
 */
export function PreviewCanvas({ element, mode, onLoaded }: PreviewCanvasProps) {
  const frame = useMemo(() => frameModel(element.bboxMm, element.dimsMm), [element]);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [orbiting, setOrbiting] = useState(true);
  // Static scenes (orbit stopped, reduced motion) stop rendering; controls and loads invalidate.
  const animating = !reducedMotion && (mode === 'hover' || orbiting);
  const url = bankRoutes.asset(element.assets.lod1.path);
  return (
    <Canvas
      frameloop={animating ? 'always' : 'demand'}
      dpr={[1, 2]}
      gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
      camera={{
        position: [...frame.position],
        fov: PREVIEW_FOV_DEG,
        near: frame.near,
        far: frame.far,
      }}
    >
      <hemisphereLight args={['#ffffff', '#52525b', 1.6]} />
      <directionalLight position={[2, 3, 4]} intensity={2} />
      <Suspense fallback={null}>
        <Model
          url={url}
          frame={frame}
          spin={mode === 'hover' && !reducedMotion}
          onLoaded={onLoaded}
        />
      </Suspense>
      {mode === 'orbit' ? (
        <OrbitControls
          enablePan={false}
          enableDamping
          autoRotate={orbiting && !reducedMotion}
          autoRotateSpeed={2.5}
          minDistance={frame.radius * 1.2}
          maxDistance={Math.hypot(...frame.position) * 3}
          onStart={() => setOrbiting(false)}
        />
      ) : null}
    </Canvas>
  );
}
