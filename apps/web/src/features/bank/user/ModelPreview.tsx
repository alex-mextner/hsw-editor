import { Suspense, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, useGLTF } from '@react-three/drei';
import { DoubleSide } from 'three';
import type { CellOffset, Conversion } from '@hsw-editor/bank';
import { useI18n } from '@/i18n/index.ts';
import { MM } from '@/scene/units.ts';
import { frameModel, PREVIEW_FOV_DEG } from '../framing.ts';
import { PreviewBoundary } from '../PreviewBoundary.tsx';
import { boxWithCells, CELL_RADIUS_MM, cellCentreMm } from './hexGrid.ts';

/** Hexagons lie a hair in front of the wall plane so they do not z-fight with the element's back face. */
const CELL_Z_MM = 0.05;
const FOOTPRINT_COLOR = '#38bdf8';
const PEG_COLOR = '#f59e0b';
/** Footprint hexagons are drawn slightly smaller than the lattice, pegs smaller still. */
const FOOTPRINT_DRAW = 0.92;
const PEG_DRAW = 0.4;

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null || canvas.getContext('webgl') !== null;
  } catch {
    return false;
  }
}

function CellHexagons({
  cells,
  scale,
  color,
  opacity,
  z,
}: {
  readonly cells: readonly CellOffset[];
  readonly scale: number;
  readonly color: string;
  readonly opacity: number;
  readonly z: number;
}) {
  return (
    <>
      {cells.map((cell) => {
        const { x, y } = cellCentreMm(cell);
        return (
          // Six segments of a circle make a hexagon with a vertex along +x, like the lattice.
          <mesh key={`${cell.dCol}_${cell.dRow2}`} position={[x * MM, y * MM, z * MM]}>
            <circleGeometry args={[CELL_RADIUS_MM * scale * MM, 6]} />
            <meshBasicMaterial
              color={color}
              transparent
              opacity={opacity}
              side={DoubleSide}
              depthWrite={false}
            />
          </mesh>
        );
      })}
    </>
  );
}

function Model({ url }: { readonly url: string }) {
  const gltf = useGLTF(url);
  // drei caches the parsed scene by URL; a clone keeps our transforms off the cache.
  const model = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  return <primitive object={model} scale={MM} />;
}

interface ModelPreviewProps {
  readonly conversion: Conversion;
  /** Cells drawn on the wall plane. */
  readonly footprint: readonly CellOffset[];
  /** Pegs highlighted inside the footprint; empty draws none. */
  readonly pegs: readonly CellOffset[];
}

/**
 * Live preview of the normalised GLB in the wall frame (mm, +z out of the wall) with the honeycomb cells of the
 * footprint on the wall plane and the mounting cells highlighted. Falls back to a text note when WebGL is
 * unavailable or the GLB cannot be loaded.
 */
export function ModelPreview({ conversion, footprint, pegs }: ModelPreviewProps) {
  const t = useI18n().t;
  const [supported] = useState(webglAvailable);
  const framed = useMemo(
    () => boxWithCells(conversion.bboxMm, footprint),
    [conversion.bboxMm, footprint],
  );
  const frame = useMemo(() => frameModel(framed.bbox, framed.dims), [framed]);
  const note = (
    <p className="flex size-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
      {t('bank.user.preview.unavailable')}
    </p>
  );
  if (!supported) return note;
  const { x, y, z } = frame.centreMm;
  return (
    <PreviewBoundary key={conversion.glbUrl} fallback={note}>
      <Canvas
        frameloop="demand"
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
        <group position={[-x * MM, -y * MM, -z * MM]}>
          <Suspense fallback={null}>
            <Model url={conversion.glbUrl} />
          </Suspense>
          <CellHexagons
            cells={footprint}
            scale={FOOTPRINT_DRAW}
            color={FOOTPRINT_COLOR}
            opacity={0.28}
            z={CELL_Z_MM}
          />
          <CellHexagons
            cells={pegs}
            scale={PEG_DRAW}
            color={PEG_COLOR}
            opacity={0.85}
            z={CELL_Z_MM * 2}
          />
        </group>
        <OrbitControls
          enablePan={false}
          enableDamping
          minDistance={frame.radius * 1.2}
          maxDistance={Math.hypot(...frame.position) * 3}
        />
      </Canvas>
    </PreviewBoundary>
  );
}
