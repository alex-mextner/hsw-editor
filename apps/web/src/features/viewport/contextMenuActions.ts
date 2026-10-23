import { editorStore, fitView, patchEditor, setSelection, type Vec2 } from '@/state/editor.ts';
import { layoutStore } from '@/state/layout.ts';
import { itemAtClient, wallPointAt } from '@/scene/viewportBridge.ts';
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  pasteClipboard,
  rotateSelection,
  selectAll,
  toggleLockSelection,
} from '@/wall/actions.ts';
import type { MenuAction, MenuTarget } from './contextMenuModel.ts';

/** Client position of the mouse/pointer/touch event that opened the menu, or null for other events. */
function clientPointOf(event: Event): Vec2 | null {
  if (
    'clientX' in event &&
    typeof event.clientX === 'number' &&
    'clientY' in event &&
    typeof event.clientY === 'number'
  ) {
    return { x: event.clientX, y: event.clientY };
  }
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    if (touch) return { x: touch.clientX, y: touch.clientY };
  }
  return null;
}

/**
 * Decides what a right-click / long-press hit by looking at the scene under the pointer (not at the
 * event target: the canvas is one element for everything). Right-clicking an item that is not part of
 * the selection selects it, so the menu always acts on what it was opened on.
 */
export function openMenuTarget(event: Event): MenuTarget {
  const at = clientPointOf(event);
  if (!at) return { kind: 'board', point: null };
  const id = itemAtClient(at.x, at.y);
  if (id === null) return { kind: 'board', point: wallPointAt(at.x, at.y) };
  if (!editorStore.get().selection.includes(id)) setSelection([id]);
  return { kind: 'item', id };
}

/** Runs the entry the user picked; the selection/clipboard/view state it needs is read at run time. */
export function runMenuAction(action: MenuAction, target: MenuTarget): void {
  const point = target.kind === 'board' ? target.point : null;
  switch (action) {
    case 'duplicate':
      duplicateSelection();
      break;
    case 'copy':
      copySelection();
      break;
    case 'rotateRight':
      rotateSelection(1);
      break;
    case 'rotateLeft':
      rotateSelection(-1);
      break;
    case 'toggleLock':
      toggleLockSelection();
      break;
    case 'properties':
      layoutStore.set({ ...layoutStore.get(), rightOpen: true });
      break;
    case 'delete':
      deleteSelection();
      break;
    case 'paste':
      if (point) pasteClipboard(point);
      break;
    case 'addHere':
      if (!point) break;
      patchEditor({ placeAt: point });
      layoutStore.set({ ...layoutStore.get(), leftOpen: true });
      break;
    case 'selectAll':
      selectAll();
      break;
    case 'viewPerspective':
      patchEditor({ view: 'perspective' });
      break;
    case 'viewFront':
      patchEditor({ view: 'front' });
      break;
    case 'fit':
      fitView();
      break;
  }
}
