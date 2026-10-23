/**
 * User-level wall actions shared by the viewport, panels, widgets and commands. Every action reads the
 * current session/selection, builds core ops and submits them; nothing mutates state directly.
 */
import type { BankElement } from '@hsw-editor/bank';
import {
  HEX_SYMMETRY_DEG,
  nearestCell,
  normalizeDeg,
  type LeafOp,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { editorStore, patchEditor, setSelection, type Vec2 } from '@/state/editor.ts';
import { wallPointAt } from '@/scene/viewportBridge.ts';
import { clipboardStore } from './clipboard.ts';
import {
  addItemOp,
  duplicateOps,
  findFreeCell,
  newItem,
  pasteOps,
  type BankLookup,
} from './edits.ts';
import type { ToolClass } from '@hsw-editor/bank';
import { offsetCell } from './footprint.ts';
import { toolPresetOps } from './toolPresets.ts';
import { sessionStore, submitOps } from './session.ts';

export function currentWall(): Wall | null {
  return sessionStore.get()?.wall ?? null;
}

export function currentBank(): BankLookup {
  const state = bankStore.get();
  return state.status === 'ready' ? state.byId : new Map();
}

export function selectedItems(): WallItem[] {
  const wall = currentWall();
  const selection = editorStore.get().selection;
  return wall ? wall.items.filter((item) => selection.includes(item.id)) : [];
}

/**
 * Adds `element` on the free cell nearest to the spot picked with "add element here" (consumed by
 * this call), else to the middle of the viewport (or the board centre when the viewport is not
 * mounted). Returns the new item id, or null when the board has no room / no wall is open.
 */
export function addElementToWall(element: BankElement): string | null {
  const wall = currentWall();
  if (!wall) return null;
  const spot = editorStore.get().placeAt ?? viewportMiddle();
  const target = nearestCell(wall.board, spot.x, spot.y);
  const cell = findFreeCell(wall, currentBank(), element, target);
  if (!cell) return null;
  const item = newItem(element, cell, wall.board);
  const result = submitOps([addItemOp(item)], 'add-item');
  if (!result.ok) return null;
  patchEditor({ placeAt: null });
  setSelection([item.id]);
  return item.id;
}

/** Remembers the selected holders/tools so Paste can put copies of them on the wall. */
export function copySelection(): void {
  const items = selectedItems().filter(
    (item) => item.kind !== 'photo-ref' && item.cell !== undefined,
  );
  if (items.length > 0) clipboardStore.set(items);
}

/**
 * Pastes the copied items with the first one on the cell nearest to `at` (default: the middle of the
 * viewport); the group slides to the nearest free spot when that one is taken. Returns false when
 * there is nothing to paste or no room.
 */
export function pasteClipboard(at?: Vec2): boolean {
  const wall = currentWall();
  const items = clipboardStore.get();
  if (!wall || items.length === 0) return false;
  const spot = at ?? viewportMiddle();
  const ops = pasteOps(wall, currentBank(), items, nearestCell(wall.board, spot.x, spot.y));
  if (ops.length === 0 || !submitOps(ops, 'paste-items').ok) return false;
  setSelection(ops.flatMap((op) => (op.type === 'addItem' ? [op.item.id] : [])));
  return true;
}

function viewportMiddle(): { x: number; y: number } {
  const wall = currentWall();
  const fallback = wall
    ? {
        x: (wall.board.cols * wall.board.colPitchMm) / 2,
        y: (wall.board.rows * wall.board.rowPitchMm) / 2,
      }
    : { x: 0, y: 0 };
  const viewport = globalThis.document?.querySelector('[data-slot="viewport"]');
  if (!viewport) return fallback;
  const rect = viewport.getBoundingClientRect();
  return wallPointAt(rect.left + rect.width / 2, rect.top + rect.height / 2) ?? fallback;
}

export function deleteSelection(): void {
  const items = selectedItems().filter((item) => !item.locked);
  if (items.length === 0) return;
  submitOps(
    items.map((item): LeafOp => ({ type: 'removeItem', id: item.id })),
    'remove-items',
  );
  setSelection([]);
}

export function duplicateSelection(): void {
  const wall = currentWall();
  if (!wall) return;
  const ops = duplicateOps(wall, currentBank(), selectedItems());
  if (ops.length === 0) return;
  if (submitOps(ops, 'duplicate-items').ok) {
    setSelection(ops.flatMap((op) => (op.type === 'addItem' ? [op.item.id] : [])));
  }
}

/** Rotates each selected item about its own anchor by `steps` lattice symmetry steps (60 degrees each). */
export function rotateSelection(steps: number): void {
  const ops = selectedItems()
    .filter((item) => !item.locked)
    .map((item): LeafOp => ({
      type: 'rotateItem',
      id: item.id,
      rotZ: normalizeDeg(item.pose.rotZ + steps * HEX_SYMMETRY_DEG),
    }));
  if (ops.length > 0) submitOps(ops, 'rotate-items');
}

/** Locks everything selected if any of it is unlocked, otherwise unlocks it. */
export function toggleLockSelection(): void {
  const items = selectedItems();
  if (items.length === 0) return;
  const lock = items.some((item) => !item.locked);
  submitOps(
    items.map((item): LeafOp => ({ type: 'lock', id: item.id, locked: lock })),
    lock ? 'lock-items' : 'unlock-items',
  );
}

/** Moves the selection by whole lattice steps (`dCol` columns, `dRow2` half-rows), staying on the board. */
export function nudgeSelection(dCol: number, dRow2: number): void {
  const wall = currentWall();
  if (!wall) return;
  const items = selectedItems().filter((item) => item.cell !== undefined && !item.locked);
  const ops: LeafOp[] = [];
  for (const item of items) {
    if (!item.cell) continue;
    const cell = offsetCell(item.cell, { dCol, dRow2 });
    if (cell.col < 0 || cell.row < 0 || cell.col >= wall.board.cols || cell.row >= wall.board.rows)
      return;
    ops.push({ type: 'moveItem', id: item.id, to: { cell } });
  }
  if (ops.length > 0) submitOps(ops, 'nudge-items');
}

export function selectAll(): void {
  const wall = currentWall();
  if (wall)
    setSelection(wall.items.filter((item) => item.kind !== 'photo-ref').map((item) => item.id));
}

/** Adds a tool of `toolClass` (typical dimensions, drawn as a box) in front of the middle of the viewport. */
export function addToolPreset(toolClass: ToolClass, label: string): string | null {
  if (!currentWall()) return null;
  const { item, ops } = toolPresetOps(toolClass, label, viewportMiddle());
  if (!submitOps(ops, 'add-tool').ok) return null;
  setSelection([item.id]);
  return item.id;
}

/**
 * Puts a new holder from the bank on the free cell nearest to `tool` and moves the tool into it
 * (`parentId`). The tool is removed and re-added in the same batch because ops cannot set a parent.
 * Returns false when there is no room or the tool is locked.
 */
export function addHolderForTool(tool: WallItem, element: BankElement): boolean {
  const wall = currentWall();
  if (!wall || tool.locked) return false;
  const near = nearestCell(wall.board, tool.pose.x, tool.pose.y);
  const cell = findFreeCell(wall, currentBank(), element, near);
  if (!cell) return false;
  const holder = newItem(element, cell, wall.board);
  const held: WallItem = {
    ...tool,
    parentId: holder.id,
    pose: { ...tool.pose, x: holder.pose.x, y: holder.pose.y, z: element.dimsMm.z / 2 },
  };
  const ok = submitOps(
    [
      { type: 'addItem', item: holder },
      { type: 'removeItem', id: tool.id },
      { type: 'addItem', item: held },
    ],
    'add-holder-for-tool',
  ).ok;
  if (ok) setSelection([held.id]);
  return ok;
}
