import { cellCenter, nearestCell } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { patchEditor, setSelection } from '@/state/editor.ts';
import { createValueStore } from '#state-backend';
import { addItemOp, fitsAt, newItem } from '@/wall/edits.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { wallPointAt } from './viewportBridge.ts';

/** MIME type carried by drags that start in the bank browser. */
export const BANK_DRAG_TYPE = 'application/x-hsw-bank-element';

/** Bank element currently dragged from the palette (dataTransfer contents are unreadable during dragover). */
export const bankDragStore = createValueStore<string | null>(null);

export function isBankDrag(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(BANK_DRAG_TYPE) ?? false;
}

/** Snapped placement for the element under the cursor, with validity (fits without overlap). */
function plan(clientX: number, clientY: number) {
  const bankId = bankDragStore.get();
  const wall = sessionStore.get()?.wall;
  const bank = bankStore.get();
  if (!bankId || !wall || bank.status !== 'ready') return null;
  const element = bank.byId.get(bankId);
  const point = wallPointAt(clientX, clientY);
  if (!element || !point) return null;
  const cell = nearestCell(wall.board, point.x, point.y);
  const centre = cellCenter(wall.board, cell);
  const item = newItem(element, cell, wall.board);
  return { wall, bank: bank.byId, element, item, centre, valid: fitsAt(wall, bank.byId, item) };
}

export function dragOverViewport(event: DragEvent): void {
  if (!isBankDrag(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  const planned = plan(event.clientX, event.clientY);
  if (!planned) return;
  patchEditor({
    ghost: {
      bankId: planned.element.id,
      x: planned.centre.x,
      y: planned.centre.y,
      valid: planned.valid,
    },
  });
}

export function leaveViewport(): void {
  patchEditor({ ghost: null });
}

export function dropOnViewport(event: DragEvent): void {
  if (!isBankDrag(event)) return;
  event.preventDefault();
  const planned = plan(event.clientX, event.clientY);
  patchEditor({ ghost: null });
  bankDragStore.set(null);
  if (!planned?.valid) return;
  if (submitOps([addItemOp(planned.item)], 'add-item').ok) setSelection([planned.item.id]);
}
