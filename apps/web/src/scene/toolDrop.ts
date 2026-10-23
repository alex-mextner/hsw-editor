/**
 * Dropping a tool from the Tools panel onto the wall. The panel calls `beginToolDrag` in `dragstart` and
 * `endToolDrag` in `dragend`; the viewport shows the same mount highlighting and refusal as when dragging a
 * tool already on the wall, hangs the new tool on a suitable mount, leaves it free anywhere else and makes
 * the drop non-droppable (no-drop cursor) on a mount that does not take it.
 */
import { planAddHung } from '@hsw-editor/compat';
import { applyOp, OpError, type LeafOp, type Wall, type WallItem } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { createValueStore } from '#state-backend';
import { patchEditor, setSelection, type AttachPreview, type Vec2 } from '@/state/editor.ts';
import { planToolDrag, toolBox, toolBoxCentre, type ToolDragPlan } from '@/wall/attach.ts';
import { seatAfterDrop } from '@/physics/postStep.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { presetDims, toolDraftOps, type Dims3 } from '@/wall/toolPresets.ts';
import { cancelSnap } from './snapAnimation.ts';
import { wallPointAt } from './viewportBridge.ts';

/** MIME type carried by drags that start on a tool card. */
export const TOOL_DRAG_TYPE = 'application/x-hsw-tool';

export interface ToolDragPayload {
  /** Bank tool-class id (`screwdriver`, ...): the vocabulary of holder `fitsTool`. */
  readonly toolClass: string;
  readonly label: string;
  /** Bounding box (width, length, thickness) in mm; the class preset when absent. */
  readonly dimsMm?: Dims3;
  /** Named dimension overrides (`shaftDiameter`, ...) the compatibility maths compares against mounts. */
  readonly params?: Readonly<Record<string, number>>;
  /** Id of the user's library tool being dragged (absent for a built-in class). */
  readonly customToolId?: string;
}

/** Tool currently dragged from the panel (dataTransfer contents are unreadable during dragover). */
export const toolDragStore = createValueStore<ToolDragPayload | null>(null);

interface Draft {
  readonly payload: ToolDragPayload;
  readonly item: WallItem;
  readonly setup: readonly LeafOp[];
}

/** One draft item per drag, so ids stay stable while the pointer moves. */
let draft: Draft | null = null;

export function beginToolDrag(
  event: { readonly dataTransfer: DataTransfer | null },
  payload: ToolDragPayload,
): void {
  const transfer = event.dataTransfer;
  if (transfer) {
    transfer.setData(TOOL_DRAG_TYPE, payload.toolClass);
    transfer.effectAllowed = 'copy';
  }
  cancelSnap();
  toolDragStore.set(payload);
  draft = null;
}

export function endToolDrag(): void {
  toolDragStore.set(null);
  draft = null;
  clearAttach();
}

export function isToolDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(TOOL_DRAG_TYPE) ?? false;
}

function draftFor(payload: ToolDragPayload, at: Vec2): Draft {
  if (draft?.payload === payload) return draft;
  const dims = payload.dimsMm ?? presetDims(payload.toolClass);
  const { item, ops } = toolDraftOps(payload.toolClass, payload.label, at, dims, {
    ...(payload.params ? { params: payload.params } : {}),
    ...(payload.customToolId === undefined ? {} : { customToolId: payload.customToolId }),
  });
  const setup = ops.filter((op) => op.type === 'addModelRef');
  draft = { payload, item, setup };
  return draft;
}

interface Planned {
  readonly item: WallItem;
  readonly setup: readonly LeafOp[];
  readonly plan: ToolDragPlan;
}

function plan(event: DragEvent): Planned | null {
  const payload = toolDragStore.get();
  const wall = sessionStore.get()?.wall;
  const bank = bankStore.get();
  const point = wallPointAt(event.clientX, event.clientY);
  // Nothing is droppable before the bank is known: with no holders every drop would look free.
  if (!payload || !wall || bank.status !== 'ready' || !point) return null;
  const current = draftFor(payload, point);
  const item: WallItem = {
    ...current.item,
    pose: { ...current.item.pose, x: point.x, y: point.y },
  };
  let virtual: Wall;
  try {
    // The tool's model reference and the tool itself exist only in this throwaway wall.
    virtual = applyOp(wall, {
      type: 'batch',
      ops: [...current.setup, { type: 'addItem', item }],
    }).wall;
  } catch (error) {
    if (error instanceof OpError) return null;
    throw error;
  }
  const planned = planToolDrag(
    virtual,
    bank.byId,
    item,
    point,
    { x: event.clientX, y: event.clientY },
    event.altKey,
  );
  // Free or refused: the stand-in follows the pointer, red when refused.
  const box = toolBox(item, virtual);
  const preview: AttachPreview =
    planned.preview.ghost === null
      ? {
          ...planned.preview,
          ghost: {
            pose: { ...item.pose },
            dimsMm: { x: box.x, y: box.y, z: box.z },
            centreMm: toolBoxCentre(box),
            valid: planned.resolution.kind !== 'refuse',
          },
        }
      : planned.preview;
  return { item, setup: current.setup, plan: { resolution: planned.resolution, preview } };
}

export function dragOverTool(event: DragEvent): void {
  if (!isToolDrag(event)) return;
  const planned = plan(event);
  if (!planned) {
    // Off the wall (or not plannable): no stale ghost, and the drop stays forbidden.
    clearAttach();
    return;
  }
  patchEditor({ attach: planned.plan.preview });
  if (planned.plan.resolution.kind === 'refuse') {
    // Not cancelling dragover leaves the drop forbidden: the browser shows the no-drop cursor.
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function clearAttach(): void {
  patchEditor({ attach: null });
}

export const leaveToolViewport = clearAttach;

export function dropTool(event: DragEvent): void {
  if (!isToolDrag(event)) return;
  event.preventDefault();
  const planned = plan(event);
  endToolDrag();
  if (!planned) return;
  const { resolution } = planned.plan;
  if (resolution.kind === 'refuse') return;
  const placed =
    resolution.kind === 'attach'
      ? planAddHung(planned.item, resolution.target)
      : ({ type: 'addItem', item: planned.item } satisfies LeafOp);
  const ok = submitOps(
    [...planned.setup, placed],
    resolution.kind === 'attach' ? 'add-and-hang' : 'add-tool',
  ).ok;
  if (!ok) return;
  setSelection([planned.item.id]);
  // Hung on the nearest holder at once; the physics then seats it (or picks a clearly better holder in reach).
  if (resolution.kind === 'attach')
    seatAfterDrop(planned.item.id, { x: planned.item.pose.x, y: planned.item.pose.y });
}
