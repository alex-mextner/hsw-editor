/**
 * User-level wall actions shared by the viewport, panels, widgets and commands. Every action reads the
 * current session/selection, builds core ops and submits them; nothing mutates state directly.
 */
import type { BankElement } from '@hsw-editor/bank';
import {
  BLOCKING_REASONS,
  evaluateHolders,
  mountTargetFor,
  planHang,
  planMoveHolder,
  planRemoveHolder,
  planRotateHolder,
  type Reason,
} from '@hsw-editor/compat';
import {
  applyOp,
  HEX_SYMMETRY_DEG,
  nearestCell,
  normalizeDeg,
  OpError,
  type LeafOp,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { notify } from '@/features/notices/notices.ts';
import { t, tn } from '@/i18n/index.ts';
import { localeStore } from '@/i18n/locale.ts';
import { editorStore, patchEditor, setSelection, type Vec2 } from '@/state/editor.ts';
import { wallPointAt } from '@/scene/viewportBridge.ts';
import { seatAfterChosenHang } from '@/physics/postStep.ts';
import { attachContext } from './attach.ts';
import { reasonText, toolClassName } from './attachReasons.ts';
import { toolClassOfItem } from './toolInterface.ts';
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
import type { ToolDragPayload } from '@/scene/toolDrop.ts';
import { presetDims, toolDraftOps, toolPresetOps } from './toolPresets.ts';
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

/** Runs a holder plan; a locked tool on the holder refuses it and the user is told why. */
function planOrNotify<T>(plan: () => T): T | null {
  try {
    return plan();
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    notify('error', error.code === 'item_locked' ? t('attach.blockedByLocked') : error.message);
    return null;
  }
}

/**
 * Removes the unlocked selection. A removed holder lets go of its tools first (they stay on the wall,
 * no longer on a holder); a holder with a locked tool is kept.
 */
export function deleteSelection(): void {
  const wall = currentWall();
  const items = selectedItems().filter((item) => !item.locked);
  if (!wall || items.length === 0) return;
  const ops: LeafOp[] = [];
  const detached = new Set<string>();
  for (const item of items.filter((candidate) => candidate.kind === 'holder')) {
    const plan = planOrNotify(() => planRemoveHolder(wall, item.id));
    if (!plan) continue;
    ops.push(...plan.op.ops);
    for (const toolId of plan.detached) detached.add(toolId);
  }
  for (const item of items) {
    if (item.kind !== 'holder') {
      ops.push({ type: 'removeItem', id: item.id });
      detached.delete(item.id);
    }
  }
  if (ops.length === 0) return;
  if (submitOps(ops, 'remove-items').ok && detached.size > 0) {
    notify('info', tn('attach.detached', detached.size));
  }
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
  const wall = currentWall();
  if (!wall) return;
  const ops: LeafOp[] = [];
  // Unlocked holders only: a tool on a locked holder is not carried, so it turns by itself.
  const selectedIds = new Set(
    selectedItems()
      .filter((item) => item.kind === 'holder' && !item.locked)
      .map((item) => item.id),
  );
  for (const item of selectedItems().filter((candidate) => !candidate.locked)) {
    const rotZ = normalizeDeg(item.pose.rotZ + steps * HEX_SYMMETRY_DEG);
    if (item.kind !== 'holder') {
      // A tool hanging on a selected holder orbits with it instead of turning by itself.
      if (!(item.parentId !== undefined && selectedIds.has(item.parentId))) {
        ops.push({ type: 'rotateItem', id: item.id, rotZ });
      }
      continue;
    }
    const plan = planOrNotify(() => planRotateHolder(wall, item.id, rotZ));
    if (plan) ops.push(...plan.ops);
  }
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
  const selectedHolders = new Set(
    selectedItems()
      .filter((item) => item.kind === 'holder' && !item.locked)
      .map((item) => item.id),
  );
  // A tool hanging on a selected holder is carried by the holder's move, not nudged by itself.
  const items = selectedItems().filter(
    (item) =>
      item.cell !== undefined &&
      !item.locked &&
      !(item.parentId !== undefined && selectedHolders.has(item.parentId)),
  );
  const ops: LeafOp[] = [];
  for (const item of items) {
    if (!item.cell) continue;
    const cell = offsetCell(item.cell, { dCol, dRow2 });
    if (cell.col < 0 || cell.row < 0 || cell.col >= wall.board.cols || cell.row >= wall.board.rows)
      return;
    // A holder's tools move with it.
    if (item.kind !== 'holder') {
      ops.push({ type: 'moveItem', id: item.id, to: { cell } });
      continue;
    }
    const plan = planOrNotify(() => planMoveHolder(wall, item.id, { cell }));
    if (plan) ops.push(...plan.ops);
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

/** Adds a Tool Library tool (class dimensions, measured params, user-tool source) in front of the middle of the viewport. */
export function addToolFromPayload(payload: ToolDragPayload): string | null {
  if (!currentWall()) return null;
  const { item, ops } = toolDraftOps(
    payload.toolClass,
    payload.label,
    viewportMiddle(),
    payload.dimsMm ?? presetDims(payload.toolClass),
    {
      ...(payload.params ? { params: payload.params } : {}),
      ...(payload.customToolId === undefined ? {} : { customToolId: payload.customToolId }),
      ...(payload.generatorClass === undefined ? {} : { generatorClass: payload.generatorClass }),
    },
  );
  if (!submitOps(ops, 'add-tool').ok) return null;
  setSelection([item.id]);
  return item.id;
}

/** Outcome of `addHolderForTool`: `refused` and `locked` already told the user why (a toast); only `no-room` is left to the caller. */
export type AddHolderResult = 'ok' | 'no-room' | 'refused' | 'locked' | 'failed';

/**
 * Puts a new holder from the bank on the free cell nearest to `tool` and hangs the tool on it (attachItem,
 * orientation and position from the mount) as one undo step.
 */
export function addHolderForTool(tool: WallItem, element: BankElement): AddHolderResult {
  const wall = currentWall();
  if (!wall) return 'failed';
  if (tool.locked) {
    notify('error', t('attach.toolLocked'));
    return 'locked';
  }
  const near = nearestCell(wall.board, tool.pose.x, tool.pose.y);
  const cell = findFreeCell(wall, currentBank(), element, near);
  if (!cell) return 'no-room';
  const holder = newItem(element, cell, wall.board);
  let withHolder: Wall;
  try {
    withHolder = applyOp(wall, { type: 'addItem', item: holder }).wall;
  } catch (error) {
    if (error instanceof OpError) return 'failed';
    throw error;
  }
  const ctx = attachContext(withHolder, currentBank());
  const target = mountTargetFor(ctx, tool, holder.id);
  if (!target) {
    const reasons = evaluateHolders(ctx, tool).find((entry) => entry.holderId === holder.id)?.compat
      .reasons;
    notify('error', refusalMessage(wall, tool, element, reasons ?? []));
    return 'refused';
  }
  const ok = submitOps(
    [{ type: 'addItem', item: holder }, planHang(tool, target)],
    'add-holder-for-tool',
  ).ok;
  if (!ok) return 'failed';
  setSelection([tool.id]);
  // A holder chosen for the tool (a suggestion): the physics seats the tool in it a moment later.
  seatAfterChosenHang(tool.id);
  return 'ok';
}

function refusalMessage(
  wall: Wall,
  tool: WallItem,
  element: BankElement,
  reasons: readonly Reason[],
): string {
  const locale = localeStore.get();
  const state = bankStore.get();
  const className = (id: string): string => toolClassName(state, locale, id);
  const title = t('attach.hint.refused', {
    tool: className(toolClassOfItem(tool, wall) ?? ''),
    holder: element.name[locale],
  });
  const why = reasons
    .filter((reason) => BLOCKING_REASONS.has(reason.code))
    .map((reason) => reasonText(t, reason, className));
  return [title, ...why].join(' ');
}
