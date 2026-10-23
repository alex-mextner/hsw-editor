import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import type { MeshBasicMaterial } from 'three';
import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import type { ScenePalette } from './palette.ts';
import { MM } from './units.ts';

interface Props {
  readonly wall: Wall;
  readonly bank: ReadonlyMap<string, BankElement>;
  readonly palette: ScenePalette;
}

/** Pulsing opacity: the glow of mounts that take the dragged tool. Keeps the demand frame loop alive. */
function usePulse(base: number, amount: number) {
  const material = useRef<MeshBasicMaterial>(null);
  useFrame(({ clock, invalidate }) => {
    if (material.current)
      material.current.opacity = base + amount * Math.sin(clock.elapsedTime * 6);
    invalidate();
  });
  return material;
}

function Glow({ color, widthMm, heightMm }: { color: string; widthMm: number; heightMm: number }) {
  const material = usePulse(0.3, 0.14);
  return (
    <mesh raycast={() => undefined} renderOrder={4}>
      <planeGeometry args={[widthMm * MM, heightMm * MM]} />
      <meshBasicMaterial
        ref={material}
        color={color}
        transparent
        opacity={0.3}
        depthTest={false}
        depthWrite={false}
      />
    </mesh>
  );
}

/**
 * While a tool is dragged: every mount that takes it glows green with a ring on each free place (the one the
 * tool would snap to is larger), every holder that does not take it is washed red, and the snapped ghost shows
 * the pose the tool will end up in.
 */
export function MountHighlights({ wall, bank, palette }: Props) {
  const attach = useStore(editorStore).attach;
  if (!attach) return null;
  const ghost = attach.ghost;
  return (
    <group name="attach-preview">
      {[...attach.holders].map(([holderId, state]) => {
        const item = wall.items.find((candidate) => candidate.id === holderId);
        const spec = item?.bankId === undefined ? undefined : bank.get(item.bankId);
        if (!item || !spec) return null;
        const { min, max } = spec.bboxMm;
        const refused = attach.refusal?.holderId === holderId;
        return (
          <group key={holderId}>
            <group
              position={[item.pose.x * MM, item.pose.y * MM, max.z * MM + 0.002]}
              rotation={[0, 0, (item.pose.rotZ * Math.PI) / 180]}
            >
              <group position={[((min.x + max.x) / 2) * MM, ((min.y + max.y) / 2) * MM, 0]}>
                {state.ok ? (
                  <Glow color={palette.ghostOk} widthMm={max.x - min.x} heightMm={max.y - min.y} />
                ) : (
                  <mesh raycast={() => undefined} renderOrder={4}>
                    <planeGeometry args={[(max.x - min.x) * MM, (max.y - min.y) * MM]} />
                    <meshBasicMaterial
                      color={palette.ghostBad}
                      transparent
                      opacity={refused ? 0.4 : 0.14}
                      depthTest={false}
                      depthWrite={false}
                    />
                  </mesh>
                )}
              </group>
            </group>
            {state.slots.map((slot) => {
              const chosen =
                attach.target?.holderId === holderId && attach.target.slot === slot.slot;
              return (
                <mesh
                  key={slot.slot}
                  position={[slot.x * MM, slot.y * MM, max.z * MM + 0.004]}
                  raycast={() => undefined}
                  renderOrder={6}
                >
                  <ringGeometry args={chosen ? [0.011, 0.018, 32] : [0.006, 0.009, 24]} />
                  <meshBasicMaterial
                    color={palette.ghostOk}
                    transparent
                    opacity={chosen ? 1 : 0.7}
                    depthTest={false}
                    depthWrite={false}
                  />
                </mesh>
              );
            })}
          </group>
        );
      })}
      {ghost ? (
        <group
          position={[ghost.pose.x * MM, ghost.pose.y * MM, ghost.pose.z * MM]}
          rotation={[
            (ghost.pose.rotX * Math.PI) / 180,
            (ghost.pose.rotY * Math.PI) / 180,
            (ghost.pose.rotZ * Math.PI) / 180,
          ]}
          renderOrder={7}
        >
          <mesh
            position={[ghost.centreMm.x * MM, ghost.centreMm.y * MM, ghost.centreMm.z * MM]}
            raycast={() => undefined}
          >
            <boxGeometry args={[ghost.dimsMm.x * MM, ghost.dimsMm.y * MM, ghost.dimsMm.z * MM]} />
            <meshBasicMaterial
              color={ghost.valid ? palette.ghostOk : palette.ghostBad}
              transparent
              opacity={0.45}
              depthWrite={false}
            />
          </mesh>
        </group>
      ) : null}
    </group>
  );
}
