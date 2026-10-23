import { Suspense, useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, useGLTF } from '@react-three/drei';
import { Box3, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { useMediaQuery } from '@/hooks/useMediaQuery.ts';
import { useT } from '@/i18n/index.ts';
import { frameModel, PREVIEW_FOV_DEG } from '@/features/bank/framing.ts';
import { PreviewBoundary } from '@/features/bank/PreviewBoundary.tsx';
import { MM } from '@/scene/units.ts';

/** One named part of a generated tool model with the material it is made of. */
export interface ModelPart {
  readonly name: string;
  /** Semantic material kind (`metal`, `plastic`, `rubber`, `wood`, ...) from the GLB extras. */
  readonly kind: string;
  /** sRGB `#rrggbb`. */
  readonly color: string;
  readonly grip: string | null;
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

interface ModelProps {
  readonly url: string;
  readonly onParts?: ((parts: readonly ModelPart[]) => void) | undefined;
}

/** A model at least this much longer (y) than it is wide is shown lying down. */
const LAY_RATIO = 1.6;

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function Model({ url, onParts }: ModelProps) {
  const gltf = useGLTF(url);
  // The cached scene belongs to drei; a clone keeps our transforms off it.
  const model = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const { frame, lay } = useMemo(() => {
    const box = new Box3().setFromObject(model);
    const size = box.getSize(new Vector3());
    // A long tool lies along x so the (wide) preview is used instead of a thin vertical strip.
    const lay = size.y > LAY_RATIO * Math.max(size.x, size.z);
    const min = lay ? { x: box.min.y, y: -box.max.x, z: box.min.z } : { x: box.min.x, y: box.min.y, z: box.min.z };
    const max = lay ? { x: box.max.y, y: -box.min.x, z: box.max.z } : { x: box.max.x, y: box.max.y, z: box.max.z };
    const dims = lay ? { x: size.y, y: size.x, z: size.z } : { x: size.x, y: size.y, z: size.z };
    return { frame: frameModel({ min, max }, dims), lay };
  }, [model]);

  useEffect(() => {
    if (!onParts) return;
    const parts: ModelPart[] = [];
    model.traverse((node) => {
      if (!(node instanceof Mesh) || Array.isArray(node.material)) return;
      const material = node.material;
      const extras: unknown = material.userData;
      const record = typeof extras === 'object' && extras !== null ? extras : {};
      parts.push({
        name: node.name || material.name,
        kind: ('kind' in record ? textOf(record.kind) : null) ?? 'plastic',
        color: material instanceof MeshStandardMaterial ? `#${material.color.getHexString()}` : '#888888',
        grip: 'grip' in record ? textOf(record.grip) : null,
      });
    });
    onParts(parts);
  }, [model, onParts]);

  const { x, y, z } = frame.centreMm;
  return (
    <>
      <PerspectiveCamera
        makeDefault
        position={[...frame.position]}
        fov={PREVIEW_FOV_DEG}
        near={frame.near}
        far={frame.far}
      />
      <group position={[-x * MM, -y * MM, -z * MM]}>
        <group rotation={[0, 0, lay ? -Math.PI / 2 : 0]}>
          <primitive object={model} scale={MM} />
        </group>
      </group>
    </>
  );
}

interface ToolPreview3DProps {
  /** GLB in millimetres (`/api/tools/...model.glb`); the camera frames the loaded model. */
  readonly url: string;
  readonly onParts?: ((parts: readonly ModelPart[]) => void) | undefined;
  readonly className?: string | undefined;
}

/**
 * Orbitable 3D preview of one generated tool model. Without WebGL, or when the GLB cannot be loaded, it shows a
 * note instead of taking the page down.
 */
export function ToolPreview3D({ url, onParts, className }: ToolPreview3DProps) {
  const t = useT();
  const [supported] = useState(webglAvailable);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const [spinning, setSpinning] = useState(true);
  const note = (
    <p className="flex size-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
      {t('toolDetail.preview.unavailable')}
    </p>
  );
  if (!supported) return <div className={className}>{note}</div>;
  return (
    <div className={className} data-testid="tool-preview-3d">
      <PreviewBoundary key={url} fallback={note}>
        <Canvas
          frameloop={spinning && !reducedMotion ? 'always' : 'demand'}
          dpr={[1, 2]}
          gl={{ alpha: true, antialias: true, powerPreference: 'low-power' }}
          camera={{ position: [0.4, 0.3, 0.8], fov: PREVIEW_FOV_DEG, near: 0.01, far: 20 }}
        >
          <hemisphereLight args={['#ffffff', '#52525b', 1.6]} />
          <directionalLight position={[2, 3, 4]} intensity={2} />
          <Suspense fallback={null}>
            <Model url={url} onParts={onParts} />
          </Suspense>
          <OrbitControls
            enablePan={false}
            enableDamping
            autoRotate={spinning && !reducedMotion}
            autoRotateSpeed={2}
            onStart={() => setSpinning(false)}
          />
        </Canvas>
      </PreviewBoundary>
    </div>
  );
}
