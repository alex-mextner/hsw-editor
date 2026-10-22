import { useState, type SyntheticEvent } from 'react';
import { Html } from '@react-three/drei';
import { Euler, Vector3 } from 'three';
import { X } from 'lucide-react';
import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import { resolveModel, variantVersion } from '@/bank/models.ts';
import { IconButton } from '@/components/IconButton.tsx';
import { useT } from '@/i18n/index.ts';
import { MM } from '@/scene/units.ts';
import { editorStore } from '@/state/editor.ts';
import { layoutStore } from '@/state/layout.ts';
import { useStore } from '@/state/react.ts';
import { DimensionWidget } from './DimensionWidget.tsx';
import { paramsDraftStore } from './draft.ts';

const DEG = Math.PI / 180;

/** The R3F canvas listens for pointer/wheel/click on its container; none of that may reach it from here. */
function keepInside(event: SyntheticEvent): void {
  event.stopPropagation();
}

interface InlineDimensionWidgetProps {
  readonly wall: Wall;
  readonly bank: ReadonlyMap<string, BankElement>;
}

/**
 * The dimension widget floating next to the selected item (top-right corner of its box), so sizes
 * can be typed where the object is, but only while the inspector panel is closed. Esc or the close button hides it until the selection changes.
 */
export function InlineDimensionWidget({ wall, bank }: InlineDimensionWidgetProps) {
  const t = useT();
  const editor = useStore(editorStore);
  const { rightOpen } = useStore(layoutStore);
  // The corner moves with the regenerated model, so follow both stores like the arrows do.
  useStore(variantVersion);
  useStore(paramsDraftStore);
  const [dismissedId, setDismissedId] = useState<string | null>(null);

  const [selectedId] = editor.selection;
  const single = editor.selection.length === 1 ? selectedId : undefined;
  // Dismissal lasts until the selection moves on: reset while rendering, not in an effect.
  if (dismissedId !== null && dismissedId !== single) setDismissedId(null);

  const item = wall.items.find((candidate) => candidate.id === single);
  const element = item?.bankId === undefined ? undefined : bank.get(item.bankId);
  // Fixed-size elements have nothing to type; the inspector still lists their dimensions.
  // With the inspector open it already carries these fields; the floating copy would only cover the canvas.
  if (rightOpen || !item || !element?.params?.length || dismissedId === item.id) return null;
  if (editor.dragging.size > 0 || editor.holding) return null;
  const source = resolveModel(item, bank);
  if (!source) return null;

  const corner = new Vector3(
    source.centreMm.x + source.dimsMm.x / 2,
    source.centreMm.y + source.dimsMm.y / 2,
    source.centreMm.z + source.dimsMm.z / 2,
  )
    .applyEuler(new Euler(item.pose.rotX * DEG, item.pose.rotY * DEG, item.pose.rotZ * DEG))
    .add(new Vector3(item.pose.x, item.pose.y, item.pose.z))
    .multiplyScalar(MM);

  const dismiss = (): void => setDismissedId(item.id);

  return (
    <Html position={corner} zIndexRange={[40, 0]}>
      {/* Presentation wrapper: only fences events off from the canvas; the dialog itself is passive. */}
      <div
        role="presentation"
        onPointerDown={keepInside}
        onPointerUp={keepInside}
        onClick={keepInside}
        onDoubleClick={keepInside}
        onWheel={keepInside}
        onKeyDown={(event) => {
          if (event.key === 'Escape') dismiss();
          // Delete, arrows and the other editor shortcuts must not act on the wall while typing here.
          keepInside(event);
        }}
      >
        <dialog
          open
          aria-label={t('widgets.dimensions.title')}
          className="static -mt-2 ml-4 block w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-xl"
        >
          <div className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <DimensionWidget item={item} element={element} />
            </div>
            <IconButton
              label={t('widgets.dimensions.closeInline')}
              size="icon-xs"
              onClick={dismiss}
            >
              <X />
            </IconButton>
          </div>
        </dialog>
      </div>
    </Html>
  );
}
