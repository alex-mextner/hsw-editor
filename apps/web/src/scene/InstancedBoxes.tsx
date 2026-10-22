import { useLayoutEffect, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import { Color, Euler, type InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { Vec3 } from '@hsw-editor/bank';
import type { Placement } from './InstancedModel.tsx';
import { MM } from './units.ts';

const DEG = Math.PI / 180;
const position = new Vector3();
const scale = new Vector3();
const quaternion = new Quaternion();
const euler = new Euler();
const matrix = new Matrix4();
const base = new Color();
const tinted = new Color();

interface InstancedBoxesProps {
  readonly dimsMm: Vec3;
  readonly centreMm: Vec3;
  readonly color: string;
  /** Material opacity; the loading stand-in is nearly solid, a failed-model placeholder is see-through. */
  readonly opacity?: number;
  readonly placements: readonly Placement[];
  readonly onItemPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
}

/** Bounding-box stand-in for items whose GLB is missing or still loading. */
export function InstancedBoxes({
  dimsMm,
  centreMm,
  color,
  opacity = 0.85,
  placements,
  onItemPointerDown,
}: InstancedBoxesProps) {
  const ref = useRef<InstancedMesh>(null);
  const capacity = Math.max(placements.length, 1);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    base.set(color);
    placements.forEach((placement, index) => {
      euler.set(placement.rotX * DEG, placement.rotY * DEG, placement.rotZ * DEG, 'XYZ');
      quaternion.setFromEuler(euler);
      // Rotate the box centre offset with the item, then place it.
      position.set(centreMm.x, centreMm.y, centreMm.z).applyQuaternion(quaternion);
      position.add(new Vector3(placement.x, placement.y, placement.z)).multiplyScalar(MM);
      scale.set(dimsMm.x * MM, dimsMm.y * MM, dimsMm.z * MM);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, placement.tint ? tinted.set(placement.tint) : base);
    });
    mesh.count = placements.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements, dimsMm, centreMm, color, capacity]);

  return (
    <instancedMesh
      key={capacity}
      ref={ref}
      args={[undefined, undefined, capacity]}
      frustumCulled={false}
      onPointerDown={(event) => {
        const instance = event.instanceId;
        const placement = instance === undefined ? undefined : placements[instance];
        if (placement) onItemPointerDown(placement.id, event);
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial roughness={0.7} transparent opacity={opacity} />
    </instancedMesh>
  );
}
