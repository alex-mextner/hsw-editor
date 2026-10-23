/**
 * Pointer-driven editing on the wall plane: moving selected items (snapped to honeycomb cells, Alt =
 * free) and rotating one item with the rotate handle. Nothing is mutated while dragging; the live
 * pose goes to `editorStore.dragging` and exactly one batch op is submitted on release.
 */
import {
  applyOp,
  cellCenter,
  nearestCell,
  OpError,
  snapRotationDeg,
  type GridCell,
  type LeafOp,
  type Wall,
} from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import {
  editorStore,
  patchEditor,
  selectItem,
  setSelection,
  type PreviewPose,
  type Vec2,
} from '@/state/editor.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { layoutProblems } from '@/wall/footprint.ts';
import { wallPointAt } from './viewportBridge.ts';

/** Screen distance (px) before a press turns into a drag, so plain clicks never move anything. */
const DRAG_THRESHOLD_PX = 4;

interface Origin {
  readonly x: number;
  readonly y: number;
  readonly cell: GridCell | undefined;
  readonly rotZ: number;
  /** Rides along with its holder: shifted by the holder's displacement, never snapped itself. */
  readonly follows?: boolean;
}

export interface DragOutcome {
  readonly poses: ReadonlyMap<string, PreviewPose & { readonly cell: GridCell | undefined }>;
  readonly valid: boolean;
}

function currentWall(): Wall | null {
  return sessionStore.get()?.wall ?? null;
}

function bankMap() {
  const state = bankStore.get();
  return state.status === 'ready' ? state.byId : new Map();
}

/** Poses after moving every dragged item by `delta` (mm), snapped to cells unless `snap` is false. */
export function planMove(
  wall: Wall,
  origins: ReadonlyMap<string, Origin>,
  primaryId: string,
  delta: Vec2,
  snap: boolean,
): DragOutcome {
  const poses = new Map<string, PreviewPose & { cell: GridCell | undefined }>();
  let shift = delta;
  const primary = origins.get(primaryId);
  if (snap && primary) {
    // Snap the pressed item first; the others move by the same lattice vector so the group keeps its shape.
    const cell = nearestCell(wall.board, primary.x + delta.x, primary.y + delta.y);
    const centre = cellCenter(wall.board, cell);
    shift = { x: centre.x - primary.x, y: centre.y - primary.y };
  }
  for (const [id, origin] of origins) {
    const x = origin.x + shift.x;
    const y = origin.y + shift.y;
    if (snap && !origin.follows) {
      const cell = nearestCell(wall.board, x, y);
      const centre = cellCenter(wall.board, cell);
      poses.set(id, { x: centre.x, y: centre.y, rotZ: origin.rotZ, cell });
    } else {
      poses.set(id, { x, y, rotZ: origin.rotZ, cell: undefined });
    }
  }
  return { poses, valid: isPlacementValid(wall, poses) };
}

function moveOps(poses: DragOutcome['poses']): LeafOp[] {
  return [...poses].map(([id, pose]) => ({
    type: 'moveItem',
    id,
    to: pose.cell ? { cell: pose.cell } : { x: pose.x, y: pose.y },
  }));
}

/** Would the wall be clean (no footprint overlap, nothing off the board) for the moved items? */
function isPlacementValid(wall: Wall, poses: DragOutcome['poses']): boolean {
  let next: Wall;
  try {
    next = applyOp(wall, { type: 'batch', ops: moveOps(poses) }).wall;
  } catch (error) {
    if (error instanceof OpError) return false;
    throw error;
  }
  const problems = layoutProblems(next.items, next.board, bankMap());
  for (const id of poses.keys()) if (problems.has(id)) return false;
  return true;
}

/** The part of an R3F pointer-down the drag handlers read (kept narrow so tests can pass a plain object). */
export interface PointerPress {
  readonly nativeEvent: Pick<
    PointerEvent,
    'button' | 'clientX' | 'clientY' | 'shiftKey' | 'ctrlKey' | 'metaKey'
  >;
  readonly stopPropagation: () => void;
}

/** Item pointer-down: select, then start a move that only becomes real after a few pixels of travel. */
export function beginItemDrag(id: string, event: PointerPress): void {
  const native = event.nativeEvent;
  const wall = currentWall();
  if (native.button !== 0 || !wall || editorStore.get().tool !== 'select') return;
  event.stopPropagation();
  const additive = native.shiftKey || native.ctrlKey || native.metaKey;
  const before = editorStore.get().selection;
  const wasSelected = before.includes(id);
  if (!wasSelected || additive) selectItem(id, additive);

  const selection = editorStore.get().selection;
  const movable = wall.items.filter((item) => selection.includes(item.id) && !item.locked);
  if (!selection.includes(id) || !movable.some((item) => item.id === id)) return;
  // Tools sitting in a moved holder travel with it.
  const carried = wall.items.filter(
    (item) =>
      item.parentId !== undefined &&
      !item.locked &&
      !selection.includes(item.id) &&
      movable.some((holder) => holder.id === item.parentId),
  );
  const start = wallPointAt(native.clientX, native.clientY);
  if (!start) return;

  const origins = new Map<string, Origin>([
    ...movable.map((item): [string, Origin] => [
      item.id,
      { x: item.pose.x, y: item.pose.y, cell: item.cell, rotZ: item.pose.rotZ },
    ]),
    ...carried.map((item): [string, Origin] => [
      item.id,
      { x: item.pose.x, y: item.pose.y, cell: undefined, rotZ: item.pose.rotZ, follows: true },
    ]),
  ]);
  const startClient = { x: native.clientX, y: native.clientY };
  let moved = false;
  let last: DragOutcome | null = null;

  const finish = (): void => {
    globalThis.removeEventListener('pointermove', onMove);
    globalThis.removeEventListener('pointerup', onUp);
    globalThis.removeEventListener('pointercancel', onCancel);
    globalThis.removeEventListener('keydown', onKey);
    patchEditor({ holding: false, dragging: new Map(), dragValid: true });
  };

  const onMove = (move: PointerEvent): void => {
    if (
      !moved &&
      Math.hypot(move.clientX - startClient.x, move.clientY - startClient.y) < DRAG_THRESHOLD_PX
    )
      return;
    moved = true;
    const point = wallPointAt(move.clientX, move.clientY);
    const live = currentWall();
    if (!point || !live) return;
    const snap = editorStore.get().snap !== move.altKey;
    last = planMove(live, origins, id, { x: point.x - start.x, y: point.y - start.y }, snap);
    patchEditor({ dragging: last.poses, dragValid: last.valid });
  };

  const onUp = (): void => {
    const outcome = last;
    finish();
    if (!moved || !outcome) {
      // A plain click inside a multi-selection narrows it to the clicked item.
      if (!additive && wasSelected && selection.length > 1) setSelection([id]);
      return;
    }
    if (!outcome.valid) return;
    const label = outcome.poses.size > 1 ? 'move-items' : 'move-item';
    submitOps(moveOps(outcome.poses), label);
  };

  const onCancel = (): void => finish();
  const onKey = (key: KeyboardEvent): void => {
    if (key.key === 'Escape') finish();
  };

  globalThis.addEventListener('pointermove', onMove);
  globalThis.addEventListener('pointerup', onUp);
  globalThis.addEventListener('pointercancel', onCancel);
  globalThis.addEventListener('keydown', onKey);
  patchEditor({ holding: true });
}

/** Rotation handle drag: angle of the pointer around the item's centre, snapped to the lattice symmetry. */
export function beginRotateDrag(itemId: string, event: PointerPress): void {
  const native = event.nativeEvent;
  const wall = currentWall();
  const item = wall?.items.find((candidate) => candidate.id === itemId);
  if (!wall || !item || item.locked || native.button !== 0) return;
  event.stopPropagation();
  const centre = { x: item.pose.x, y: item.pose.y };
  const angleOf = (point: Vec2): number =>
    (Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI;
  const startPoint = wallPointAt(native.clientX, native.clientY);
  if (!startPoint) return;
  const startAngle = angleOf(startPoint);
  const startRot = item.pose.rotZ;
  let lastRot = startRot;

  const finish = (): void => {
    globalThis.removeEventListener('pointermove', onMove);
    globalThis.removeEventListener('pointerup', onUp);
    globalThis.removeEventListener('pointercancel', onCancel);
    patchEditor({ holding: false, dragging: new Map(), dragValid: true });
  };
  const onMove = (move: PointerEvent): void => {
    const point = wallPointAt(move.clientX, move.clientY);
    if (!point) return;
    const raw = startRot + angleOf(point) - startAngle;
    lastRot =
      editorStore.get().snap !== move.altKey ? snapRotationDeg(raw) : ((raw % 360) + 360) % 360;
    patchEditor({
      dragging: new Map([[itemId, { x: centre.x, y: centre.y, rotZ: lastRot }]]),
      dragValid: true,
    });
  };
  const onUp = (): void => {
    finish();
    if (lastRot !== startRot)
      submitOps([{ type: 'rotateItem', id: itemId, rotZ: lastRot }], 'rotate-item');
  };
  const onCancel = (): void => finish();
  globalThis.addEventListener('pointermove', onMove);
  globalThis.addEventListener('pointerup', onUp);
  globalThis.addEventListener('pointercancel', onCancel);
  patchEditor({ holding: true });
}
