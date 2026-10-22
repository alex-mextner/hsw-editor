import { useLayoutEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import {
  Color,
  Euler,
  type BufferGeometry,
  type InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from 'three';
import { MM } from './units.ts';

/** One placement of a model: pose in wall frame (mm, degrees) plus the tint state. */
export interface Placement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotX: number;
  readonly rotY: number;
  readonly rotZ: number;
  readonly tint: string | null;
}

interface Part {
  readonly geometry: BufferGeometry;
  readonly material: Material | Material[];
  /** Transform of the mesh relative to the GLB root. */
  readonly local: Matrix4;
}

function collectParts(root: Object3D): Part[] {
  root.updateMatrixWorld(true);
  const parts: Part[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    parts.push({
      geometry: mesh.geometry,
      material: mesh.material,
      local: mesh.matrixWorld.clone(),
    });
  });
  return parts;
}

const DEG = Math.PI / 180;
const scratchPosition = new Vector3();
const scratchQuaternion = new Quaternion();
const scratchEuler = new Euler();
const scratchScale = new Vector3(MM, MM, MM);
const scratchPlacement = new Matrix4();
const scratchResult = new Matrix4();
const scratchColor = new Color();
const WHITE = new Color('#ffffff');

interface InstancedModelProps {
  readonly url: string;
  readonly placements: readonly Placement[];
  readonly onItemPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
}

/**
 * All placements of one GLB drawn with one InstancedMesh per GLB mesh: 200 holders of the same
 * element cost a handful of draw calls instead of 200 x parts.
 */
export function InstancedModel({ url, placements, onItemPointerDown }: InstancedModelProps) {
  const gltf = useGLTF(url);
  const parts = useMemo(() => collectParts(gltf.scene), [gltf.scene]);
  const refs = useRef<(InstancedMesh | null)[]>([]);
  // Instanced meshes are rebuilt when the capacity changes; placements only update matrices/colours.
  const capacity = Math.max(placements.length, 1);

  useLayoutEffect(() => {
    parts.forEach((part, partIndex) => {
      const mesh = refs.current[partIndex];
      if (!mesh) return;
      placements.forEach((placement, index) => {
        scratchPosition.set(placement.x * MM, placement.y * MM, placement.z * MM);
        scratchEuler.set(placement.rotX * DEG, placement.rotY * DEG, placement.rotZ * DEG, 'XYZ');
        scratchQuaternion.setFromEuler(scratchEuler);
        scratchPlacement.compose(scratchPosition, scratchQuaternion, scratchScale);
        scratchResult.multiplyMatrices(scratchPlacement, part.local);
        mesh.setMatrixAt(index, scratchResult);
        mesh.setColorAt(index, placement.tint ? scratchColor.set(placement.tint) : WHITE);
      });
      mesh.count = placements.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.computeBoundingBox();
    });
  }, [parts, placements, capacity]);

  return (
    <>
      {parts.map((part, partIndex) => (
        <instancedMesh
          // The capacity is part of the key so a bigger group gets a fresh, larger buffer.
          key={`${partIndex}:${capacity}`}
          ref={(mesh) => {
            refs.current[partIndex] = mesh;
          }}
          args={[part.geometry, part.material, capacity]}
          frustumCulled={false}
          onPointerDown={(event) => {
            const instance = event.instanceId;
            const placement = instance === undefined ? undefined : placements[instance];
            if (placement) onItemPointerDown(placement.id, event);
          }}
        />
      ))}
    </>
  );
}
