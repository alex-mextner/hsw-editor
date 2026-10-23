import { useEffect, useMemo } from 'react';
import { Edges, useGLTF } from '@react-three/drei';
import { Box3, Color, Mesh, MeshStandardMaterial, Vector3, type Object3D } from 'three';
import type { ModelRef } from '@hsw-editor/core';
import { api } from '@/api/http.ts';
import { ModelBoundary } from '@/scene/ModelBoundary.tsx';
import { MM } from '@/scene/units.ts';
import type { Dims } from './compareMath.ts';

/** Box drawn for a model without a GLB, and while one is loading. */
export const FALLBACK_DIMS_MM: Dims = { x: 60, y: 60, z: 60 };

interface CompareModelProps {
  readonly wallId: string;
  readonly model: ModelRef;
  readonly color: string;
  readonly opacity: number;
  /** Replace the GLB's own materials by `color` (overlay and ghost need to tell candidates apart). */
  readonly tint: boolean;
  /** Real size of a loaded GLB, reported so the tile can frame the camera when `dimensionsMm` is unknown. */
  readonly onSize: (id: string, dims: Dims) => void;
}

export function DimBox({
  dims,
  color,
  opacity,
}: {
  readonly dims: Dims;
  readonly color: string;
  readonly opacity: number;
}) {
  return (
    <mesh>
      <boxGeometry args={[dims.x * MM, dims.y * MM, dims.z * MM]} />
      <meshStandardMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity >= 1}
        roughness={0.7}
      />
      <Edges color={color} />
    </mesh>
  );
}

/** Wireframe of the item's current size: the yardstick the candidates are held against. */
export function ReferenceBox({ dims, color }: { readonly dims: Dims; readonly color: string }) {
  return (
    <mesh>
      <boxGeometry args={[dims.x * MM, dims.y * MM, dims.z * MM]} />
      <meshBasicMaterial color={color} wireframe transparent opacity={0.6} />
    </mesh>
  );
}

function tinted(root: Object3D, color: string, opacity: number): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: new Color(color),
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
    roughness: 0.6,
  });
  root.traverse((node) => {
    if (node instanceof Mesh) node.material = material;
  });
  return material;
}

function GlbModel({ wallId, model, color, opacity, tint, onSize }: CompareModelProps) {
  const gltf = useGLTF(api.modelUrl(wallId, model.id));
  const prepared = useMemo(() => {
    // Clone so one cached GLB can be drawn with different tints in different tiles.
    const root = gltf.scene.clone(true);
    const bounds = new Box3().setFromObject(root);
    const centre = bounds.getCenter(new Vector3());
    const size = bounds.getSize(new Vector3());
    const material = tint ? tinted(root, color, opacity) : null;
    return { root, centre, size, material };
  }, [gltf.scene, tint, color, opacity]);

  useEffect(() => () => prepared.material?.dispose(), [prepared]);
  useEffect(() => {
    onSize(model.id, { x: prepared.size.x, y: prepared.size.y, z: prepared.size.z });
  }, [model.id, prepared.size, onSize]);

  // The GLB is authored in millimetres like the bank: scale to scene metres, centre on the origin.
  return (
    <group scale={MM}>
      <primitive
        object={prepared.root}
        position={[-prepared.centre.x, -prepared.centre.y, -prepared.centre.z]}
      />
    </group>
  );
}

/** A model that fails to load (bad GLB, 404) degrades to its box instead of taking the tile down. */
export function CompareModel(props: CompareModelProps) {
  const { wallId, model, color, opacity } = props;
  const box = (
    <DimBox dims={model.dimensionsMm ?? FALLBACK_DIMS_MM} color={color} opacity={opacity} />
  );
  if (model.file === undefined) return box;
  return (
    <ModelBoundary
      url={api.modelUrl(wallId, model.id)}
      name={model.label}
      fallback={box}
      placeholder={() => box}
    >
      <GlbModel {...props} />
    </ModelBoundary>
  );
}
