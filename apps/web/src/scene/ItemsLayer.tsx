import { Suspense, useMemo, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { BankElement } from '@hsw-editor/bank';
import type { Wall, WallItem } from '@hsw-editor/core';
import { resolveModel, variantVersion, type ModelSource } from '@/bank/models.ts';
import { toolDims } from '@/wall/toolPresets.ts';
import { useStore } from '@/state/react.ts';
import { editorStore } from '@/state/editor.ts';
import { InstancedModel, type Placement } from './InstancedModel.tsx';
import { InstancedBoxes } from './InstancedBoxes.tsx';
import type { ScenePalette } from './palette.ts';
import { mm } from './units.ts';

/** Camera distance (m) beyond which the reduced LOD1 meshes are used; hysteresis avoids flicker. */
const LOD_FAR_ENTER = 2.4;
const LOD_FAR_EXIT = 2.0;

function useFarLod(wall: Wall): boolean {
  const [far, setFar] = useState(false);
  const centreX = mm((wall.board.cols * wall.board.colPitchMm) / 2);
  useFrame(({ camera }) => {
    const dx = camera.position.x - centreX;
    const distance = Math.hypot(dx, camera.position.y - 0.4, camera.position.z);
    // Orthographic cameras zoom instead of moving: treat a small zoom as "far".
    const orthoFar = 'zoom' in camera && camera.type === 'OrthographicCamera' && camera.zoom < 250;
    const next =
      orthoFar ||
      (camera.type !== 'OrthographicCamera' && distance > (far ? LOD_FAR_EXIT : LOD_FAR_ENTER));
    if (next !== far) setFar(next);
  });
  return far;
}

interface ItemsLayerProps {
  readonly wall: Wall;
  readonly bank: ReadonlyMap<string, BankElement>;
  readonly palette: ScenePalette;
  readonly invalidIds: ReadonlySet<string>;
  readonly onItemPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
}

interface Group {
  readonly source: ModelSource | null;
  /** Box stand-in for items without a bank model (tool presets, missing assets). */
  readonly boxMm: { readonly x: number; readonly y: number; readonly z: number };
  readonly items: WallItem[];
}

const FALLBACK_BOX = { x: 30, y: 30, z: 20 };

function boxFor(item: WallItem, wall: Wall) {
  return item.kind === 'tool' ? (toolDims(item, wall) ?? FALLBACK_BOX) : FALLBACK_BOX;
}

/** Items sharing one model (or one stand-in box size) draw together as a single instanced group. */
function groupItems(wall: Wall, bank: ReadonlyMap<string, BankElement>): [string, Group][] {
  const byKey = new Map<string, Group>();
  for (const item of wall.items) {
    if (item.kind === 'photo-ref') continue;
    const source = resolveModel(item, bank);
    const boxMm = boxFor(item, wall);
    const key = source?.key ?? `box:${boxMm.x}x${boxMm.y}x${boxMm.z}`;
    const group = byKey.get(key);
    if (group) group.items.push(item);
    else byKey.set(key, { source, boxMm, items: [item] });
  }
  return [...byKey.entries()];
}

export function ItemsLayer({
  wall,
  bank,
  palette,
  invalidIds,
  onItemPointerDown,
}: ItemsLayerProps) {
  const editor = useStore(editorStore);
  // Re-render when a regenerated model arrives: `resolveModel` reads that cache outside React state.
  useStore(variantVersion);
  const far = useFarLod(wall);
  const groups = groupItems(wall, bank);

  const selected = useMemo(() => new Set(editor.selection), [editor.selection]);

  return (
    <group name="items">
      {groups.map(([key, group]) => {
        const placements: Placement[] = group.items.map((item) => {
          const live = editor.dragging.get(item.id);
          const tint = live
            ? editor.dragValid
              ? palette.ghostOk
              : palette.ghostBad
            : invalidIds.has(item.id)
              ? palette.itemInvalid
              : selected.has(item.id)
                ? palette.itemSelected
                : item.locked
                  ? palette.itemLocked
                  : null;
          return {
            id: item.id,
            x: live?.x ?? item.pose.x,
            y: live?.y ?? item.pose.y,
            z: item.pose.z,
            rotX: item.pose.rotX,
            rotY: item.pose.rotY,
            rotZ: live?.rotZ ?? item.pose.rotZ,
            tint,
          };
        });
        if (!group.source) {
          return (
            <InstancedBoxes
              key={key}
              dimsMm={group.boxMm}
              centreMm={{ x: 0, y: 0, z: group.boxMm.z / 2 }}
              color={palette.item}
              placements={placements}
              onItemPointerDown={onItemPointerDown}
            />
          );
        }
        const url = far ? group.source.lod1 : group.source.lod0;
        return (
          <Suspense
            key={key}
            fallback={
              <InstancedBoxes
                dimsMm={group.source.dimsMm}
                centreMm={group.source.centreMm}
                color={palette.item}
                placements={placements}
                onItemPointerDown={onItemPointerDown}
              />
            }
          >
            <InstancedModel
              url={url}
              placements={placements}
              onItemPointerDown={onItemPointerDown}
            />
          </Suspense>
        );
      })}
    </group>
  );
}
