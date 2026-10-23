import { useMemo } from 'react';
import { useGLTF } from '@react-three/drei';
import { Color, DoubleSide, MeshBasicMaterial, type Mesh, type Object3D } from 'three';
import type { BankElement } from '@hsw-editor/bank';
import { bankRoutes } from '@/bank/client.ts';
import { useI18n } from '@/i18n/index.ts';
import { ModelBoundary } from './ModelBoundary.tsx';
import { MM } from './units.ts';

interface GhostItemProps {
  readonly element: BankElement;
  readonly xMm: number;
  readonly yMm: number;
  readonly rotZ: number;
  readonly color: string;
}

/** Translucent preview of a bank element while it is dragged over the wall; green = fits, red = blocked. */
export function GhostItem({ element, xMm, yMm, rotZ, color }: GhostItemProps) {
  const { locale } = useI18n();
  const dims = element.dimsMm;
  const centre = {
    x: (element.bboxMm.min.x + element.bboxMm.max.x) / 2,
    y: (element.bboxMm.min.y + element.bboxMm.max.y) / 2,
    z: (element.bboxMm.min.z + element.bboxMm.max.z) / 2,
  };
  // The box doubles as the loading stand-in and as what stays if the GLB cannot be loaded.
  const box = (
    <mesh position={[centre.x * MM, centre.y * MM, centre.z * MM]} raycast={() => undefined}>
      <boxGeometry args={[dims.x * MM, dims.y * MM, dims.z * MM]} />
      <meshBasicMaterial color={color} transparent opacity={0.4} depthWrite={false} />
    </mesh>
  );
  return (
    <group
      position={[xMm * MM, yMm * MM, 0]}
      rotation={[0, 0, (rotZ * Math.PI) / 180]}
      renderOrder={5}
    >
      <ModelBoundary
        url={bankRoutes.asset(element.assets.lod1.path)}
        bankId={element.id}
        name={element.name[locale]}
        fallback={box}
        placeholder={() => box}
      >
        <GhostModel url={bankRoutes.asset(element.assets.lod1.path)} color={color} />
      </ModelBoundary>
    </group>
  );
}

function GhostModel({ url, color }: { readonly url: string; readonly color: string }) {
  const gltf = useGLTF(url);
  const object = useMemo<Object3D>(() => {
    const clone = gltf.scene.clone(true);
    const material = new MeshBasicMaterial({
      color: new Color(color),
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: DoubleSide,
    });
    clone.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh) {
        mesh.material = material;
        mesh.raycast = () => undefined;
      }
    });
    return clone;
  }, [gltf.scene, color]);
  return <primitive object={object} scale={MM} />;
}
