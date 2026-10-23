import { useMemo, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import { goneReasonFor } from '@/bank/assetRecovery.ts';
import { lastKnownElement } from '@/bank/client.ts';
import { failureReason } from '@/bank/failureView.ts';
import { variantVersion } from '@/bank/models.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { editorStore } from '@/state/editor.ts';
import { InstancedModel, type Placement } from './InstancedModel.tsx';
import { InstancedBoxes } from './InstancedBoxes.tsx';
import { groupItems } from './itemGroups.ts';
import { ModelBoundary } from './ModelBoundary.tsx';
import { ModelPlaceholder } from './ModelPlaceholder.tsx';
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
  /** The bank index is loaded: only then is an absent element id "missing from the bank". */
  readonly bankReady: boolean;
  readonly palette: ScenePalette;
  readonly onItemPointerDown: (id: string, event: ThreeEvent<PointerEvent>) => void;
}

export function ItemsLayer({ wall, bank, bankReady, palette, onItemPointerDown }: ItemsLayerProps) {
  const { t, locale } = useI18n();
  const editor = useStore(editorStore);
  // Re-render when a regenerated model arrives: `resolveModel` reads that cache outside React state.
  useStore(variantVersion);
  const far = useFarLod(wall);
  const groups = groupItems(wall, bank, bankReady);

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
            : selected.has(item.id)
              ? palette.itemSelected
              : item.locked
                ? palette.itemLocked
                : null;
          return {
            id: item.id,
            x: live?.x ?? item.pose.x,
            y: live?.y ?? item.pose.y,
            z: live?.z ?? item.pose.z,
            rotX: live?.rotX ?? item.pose.rotX,
            rotY: live?.rotY ?? item.pose.rotY,
            rotZ: live?.rotZ ?? item.pose.rotZ,
            tint,
          };
        });
        if (group.missing) {
          const gone = goneReasonFor(group.missing.bankId) ?? { kind: 'removed' as const };
          return (
            <ModelPlaceholder
              key={key}
              dimsMm={group.boxMm}
              centreMm={group.centreMm}
              placements={placements}
              palette={palette}
              name={lastKnownElement(group.missing.bankId)?.name[locale] ?? group.missing.name}
              reason={failureReason({ kind: 'unknown', gone }, t)}
              onItemPointerDown={onItemPointerDown}
            />
          );
        }
        if (!group.source) {
          return (
            <InstancedBoxes
              key={key}
              dimsMm={group.boxMm}
              centreMm={group.centreMm}
              color={palette.item}
              placements={placements}
              onItemPointerDown={onItemPointerDown}
            />
          );
        }
        const { source } = group;
        const url = far ? source.lod1 : source.lod0;
        return (
          // One boundary per instanced group: a failing model never takes the other groups down.
          <ModelBoundary
            key={key}
            url={url}
            bankId={source.element.id}
            name={source.element.name[locale]}
            fallback={
              <InstancedBoxes
                dimsMm={source.dimsMm}
                centreMm={source.centreMm}
                color={palette.item}
                placements={placements}
                onItemPointerDown={onItemPointerDown}
              />
            }
            placeholder={(view) => (
              <ModelPlaceholder
                dimsMm={source.dimsMm}
                centreMm={source.centreMm}
                placements={placements}
                palette={palette}
                name={view.name}
                reason={view.reason}
                onItemPointerDown={onItemPointerDown}
              />
            )}
          >
            <InstancedModel
              url={url}
              placements={placements}
              onItemPointerDown={onItemPointerDown}
            />
          </ModelBoundary>
        );
      })}
    </group>
  );
}
