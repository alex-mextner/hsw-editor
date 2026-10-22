import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { OrbitControls, PerspectiveCamera, View } from '@react-three/drei';
import type { ModelRef } from '@hsw-editor/core';
import { cn } from '@/lib/cn.ts';
import { MM } from '@/scene/units.ts';
import type { Dims } from './compareMath.ts';
import { CompareModel, FALLBACK_DIMS_MM, ReferenceBox } from './CompareModel.tsx';

export interface ViewportEntry {
  readonly model: ModelRef;
  readonly color: string;
  readonly opacity: number;
  readonly tint: boolean;
}

interface CompareViewportProps {
  readonly wallId: string;
  readonly entries: readonly ViewportEntry[];
  /** Current size of the item, drawn as a wireframe yardstick. */
  readonly reference: Dims | null;
  readonly referenceColor: string;
  readonly className?: string;
  /** DOM drawn behind the (transparent) 3D view, e.g. the wall photo for the ghost mode. */
  readonly background?: ReactNode;
}

function sameDims(a: Dims, b: Dims): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * One tile of the shared compare canvas: a drei `View` follows this element's rectangle, so any
 * number of tiles cost one WebGL context. Each tile has its own camera and orbit controls.
 */
export function CompareViewport({
  wallId,
  entries,
  reference,
  referenceColor,
  className,
  background,
}: CompareViewportProps) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<ReadonlyMap<string, Dims>>(new Map());
  const onSize = useCallback((id: string, dims: Dims) => {
    setMeasured((previous) => {
      const current = previous.get(id);
      if (current && sameDims(current, dims)) return previous;
      return new Map(previous).set(id, dims);
    });
  }, []);

  // Sphere around everything shown, so the camera frames the biggest candidate (or the yardstick).
  const extentMm = useMemo(() => {
    const sizes = entries.map(
      ({ model }) => model.dimensionsMm ?? measured.get(model.id) ?? FALLBACK_DIMS_MM,
    );
    if (reference) sizes.push(reference);
    return Math.max(...sizes.map((dims) => Math.hypot(dims.x, dims.y, dims.z)), 1);
  }, [entries, measured, reference]);

  const distance = extentMm * MM * 1.5;
  return (
    <div className={cn('relative overflow-hidden rounded-md bg-viewport', className)}>
      {background}
      <View
        className="absolute inset-0 touch-none"
        ref={(node) => setElement(node instanceof HTMLElement ? node : null)}
      >
        <ambientLight intensity={1} />
        <directionalLight position={[1, 2, 3]} intensity={1.6} />
        <directionalLight position={[-2, 0.5, 1]} intensity={0.5} />
        <PerspectiveCamera
          makeDefault
          fov={35}
          near={distance / 100}
          far={distance * 100}
          position={[distance * 0.6, distance * 0.45, distance]}
        />
        {element ? (
          <OrbitControls
            makeDefault
            domElement={element}
            enableDamping
            minDistance={distance * 0.3}
            maxDistance={distance * 4}
          />
        ) : null}
        {reference ? <ReferenceBox dims={reference} color={referenceColor} /> : null}
        {entries.map((entry) => (
          <CompareModel
            key={entry.model.id}
            wallId={wallId}
            model={entry.model}
            color={entry.color}
            opacity={entry.opacity}
            tint={entry.tint}
            onSize={onSize}
          />
        ))}
      </View>
    </div>
  );
}
