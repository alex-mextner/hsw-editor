import { useMemo } from 'react';
import { BoxGeometry, EdgesGeometry } from 'three';
import type { Wall } from '@hsw-editor/core';
import type { BankLookup } from '@/wall/edits.ts';
import { variantVersion } from '@/bank/models.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { beginRotateDrag } from './dragController.ts';
import { itemBounds } from './itemBounds.ts';
import type { ScenePalette } from './palette.ts';
import { MM } from './units.ts';

const DEG = Math.PI / 180;
const HANDLE_GAP_MM = 22;

interface SelectionFramesProps {
  readonly wall: Wall;
  readonly bank: BankLookup;
  readonly palette: ScenePalette;
  readonly invalidIds: ReadonlySet<string>;
}

/** Wireframe box around every selected item, plus the rotate handle when exactly one is selected. */
export function SelectionFrames({ wall, bank, palette, invalidIds }: SelectionFramesProps) {
  const editor = useStore(editorStore);
  // Re-render when a regenerated model arrives so the frame follows the new dimensions.
  useStore(variantVersion);
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(1, 1, 1)), []);
  const single = editor.selection.length === 1;
  const selected = wall.items.filter((item) => editor.selection.includes(item.id));

  return (
    <group name="selection">
      {selected.map((item) => {
        const bounds = itemBounds(item, wall, bank);
        if (!bounds) return null;
        const live = editor.dragging.get(item.id);
        const x = live?.x ?? item.pose.x;
        const y = live?.y ?? item.pose.y;
        const z = live?.z ?? item.pose.z;
        const rotX = live?.rotX ?? item.pose.rotX;
        const rotY = live?.rotY ?? item.pose.rotY;
        const rotZ = live?.rotZ ?? item.pose.rotZ;
        const { dims, centre } = bounds;
        const bad = invalidIds.has(item.id) || (live !== undefined && !editor.dragValid);
        const color = bad ? palette.itemInvalid : palette.itemSelected;
        const handleY = dims.y / 2 + centre.y + HANDLE_GAP_MM;
        return (
          <group
            key={item.id}
            position={[x * MM, y * MM, z * MM]}
            rotation={[rotX * DEG, rotY * DEG, rotZ * DEG]}
          >
            <lineSegments
              position={[centre.x * MM, centre.y * MM, centre.z * MM]}
              scale={[dims.x * MM, dims.y * MM, dims.z * MM]}
              geometry={edges}
              raycast={() => undefined}
            >
              <lineBasicMaterial color={color} depthTest={false} transparent opacity={0.95} />
            </lineSegments>
            {single && !item.locked ? (
              <group position={[centre.x * MM, handleY * MM, (centre.z + dims.z / 2) * MM]}>
                <mesh onPointerDown={(event) => beginRotateDrag(item.id, event)} renderOrder={10}>
                  <circleGeometry args={[7 * MM, 24]} />
                  <meshBasicMaterial color={color} depthTest={false} />
                </mesh>
                <mesh raycast={() => undefined} renderOrder={11}>
                  <ringGeometry args={[3 * MM, 4.2 * MM, 24, 1, 0.4, 4.6]} />
                  <meshBasicMaterial color="#1b1b1f" depthTest={false} />
                </mesh>
              </group>
            ) : null}
          </group>
        );
      })}
    </group>
  );
}
