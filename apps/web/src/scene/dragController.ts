/**
 * Pointer-driven editing on the wall plane: moving selected items (snapped to honeycomb cells, Alt =
 * free), dragging one tool onto a suitable mount (suitable mounts glow, the rest refuse with a reason)
 * and rotating one item with the rotate handle. Holders carry their hanging tools. Nothing is mutated
 * while dragging; the live pose goes to `editorStore.dragging` and exactly one batch op is submitted on
 * release.
 */
import { planHang, planRotateHolder } from '@hsw-editor/compat';
import {
  applyOp,
  cellCenter,
  nearestCell,
  OpError,
  snapRotationDeg,
  type GridCell,
  type LeafOp,
  type Op,
  type Wall,
  type WallItem,
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
import { moveItemsOps, planToolDrag } from '@/wall/attach.ts';
import { layoutProblems } from '@/wall/footprint.ts';
import { cancelSnap, glideTo } from './snapAnimation.ts';
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
  if (snap && primary && !primary.follows) {
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

/** Would the wall be clean (no footprint overlap, nothing off the board) for the moved items? */
function isPlacementValid(wall: Wall, poses: DragOutcome['poses']): boolean {
  let next: Wall;
  try {
    next = applyOp(wall, { type: 'batch', ops: moveItemsOps(wall, poses) }).wall;
  } catch (error) {
    if (error instanceof OpError) return false;
    throw error;
  }
  const problems = layoutProblems(next.items, next.board, bankMap());
  for (const id of poses.keys()) if (problems.has(id)) return false;
  return true;
}

function samePose(a: Wall['items'][number]['pose'], b: Wall['items'][number]['pose']): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.z === b.z &&
    a.rotX === b.rotX &&
    a.rotY === b.rotY &&
    a.rotZ === b.rotZ
  );
}

/** Poses of every item whose pose `op` changes, as drag previews (a holder's tools orbit with it). */
function posesAfter(wall: Wall, op: Op): Map<string, PreviewPose> {
  const before = new Map(wall.items.map((item) => [item.id, item.pose]));
  const out = new Map<string, PreviewPose>();
  for (const item of applyOp(wall, op).wall.items) {
    const pose = before.get(item.id);
    if (pose !== undefined && !samePose(pose, item.pose)) {
      out.set(item.id, { ...item.pose });
    }
  }
  return out;
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
  const selected = wall.items.filter((item) => selection.includes(item.id) && !item.locked);
  // A selected tool on a selected holder rides along with it instead of moving by itself.
  const holderIds = new Set(selected.filter((item) => item.kind === 'holder').map((i) => i.id));
  const movable = selected.filter(
    (item) => !(item.parentId !== undefined && holderIds.has(item.parentId)),
  );
  const pressedItem = wall.items.find((item) => item.id === id);
  // Pressing a tool that rides on a selected holder drags that holder, tool included.
  const primaryId = movable.some((item) => item.id === id)
    ? id
    : pressedItem?.parentId !== undefined && holderIds.has(pressedItem.parentId)
      ? pressedItem.parentId
      : null;
  if (!selection.includes(id) || primaryId === null) return;
  const start = wallPointAt(native.clientX, native.clientY);
  if (!start) return;
  cancelSnap();
  if (pressedItem?.kind === 'tool' && movable.length === 1 && movable[0]?.id === id) {
    // Without the bank no holder is known, so every drop would look free and detach a hung tool: do not drag it.
    if (pressedItem.parentId !== undefined && bankStore.get().status !== 'ready') return;
    beginWallToolDrag(pressedItem, native, start, () => {
      // A plain click inside a multi-selection narrows it to the clicked tool.
      if (!additive && wasSelected && selection.length > 1) setSelection([id]);
    });
    return;
  }
  // Tools hanging in a moved holder travel with it (even locked ones, which then block the move).
  const carried = wall.items.filter(
    (item) =>
      item.parentId !== undefined && holderIds.has(item.parentId) && !movable.includes(item),
  );

  const origins = new Map<string, Origin>([
    ...movable.map((item): [string, Origin] => [
      item.id,
      {
        x: item.pose.x,
        y: item.pose.y,
        cell: item.cell,
        rotZ: item.pose.rotZ,
      },
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
    last = planMove(live, origins, primaryId, { x: point.x - start.x, y: point.y - start.y }, snap);
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
    try {
      submitOps(moveItemsOps(currentWall() ?? wall, outcome.poses), label);
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
    }
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

function fullPose(item: WallItem): Required<PreviewPose> {
  const { x, y, z, rotX, rotY, rotZ } = item.pose;
  return { x, y, z, rotX, rotY, rotZ };
}

/**
 * Dragging one tool: it follows the pointer while a ghost shows where it would hang, suitable mounts glow
 * and an unsuitable one under the pointer refuses (the tool then glides back). Alt drops it anywhere free.
 * Releasing on a mount hangs it (one undo step) and the tool glides onto its slot.
 */
function beginWallToolDrag(
  tool: WallItem,
  native: PointerPress['nativeEvent'],
  start: Vec2,
  onClick: () => void,
): void {
  const id = tool.id;
  const origin = fullPose(tool);
  const startClient = { x: native.clientX, y: native.clientY };
  let moved = false;
  let last: {
    readonly pose: Required<PreviewPose>;
    readonly point: Vec2;
    readonly cursor: Vec2;
    readonly free: boolean;
  } | null = null;

  const finish = (): void => {
    globalThis.removeEventListener('pointermove', onMove);
    globalThis.removeEventListener('pointerup', onUp);
    globalThis.removeEventListener('pointercancel', onCancel);
    globalThis.removeEventListener('keydown', onKey);
    patchEditor({ holding: false, dragging: new Map(), dragValid: true, attach: null });
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
    const liveTool = live?.items.find((item) => item.id === id);
    if (!point || !live || !liveTool) return;
    const pose = { ...origin, x: origin.x + point.x - start.x, y: origin.y + point.y - start.y };
    const cursor = { x: move.clientX, y: move.clientY };
    const plan = planToolDrag(live, bankMap(), liveTool, point, cursor, move.altKey);
    last = { pose, point, cursor, free: move.altKey };
    patchEditor({
      dragging: new Map([[id, pose]]),
      dragValid: plan.resolution.kind !== 'refuse',
      attach: plan.preview,
    });
  };

  const onUp = (): void => {
    const outcome = last;
    finish();
    const live = currentWall();
    const liveTool = live?.items.find((item) => item.id === id);
    if (!moved) {
      onClick();
      return;
    }
    if (!outcome || !live || !liveTool) return;
    // Decided again against the wall as it is now: a remote edit may have filled the slot meanwhile.
    const { resolution } = planToolDrag(
      live,
      bankMap(),
      liveTool,
      outcome.point,
      outcome.cursor,
      outcome.free,
    );
    if (resolution.kind === 'refuse') {
      glideTo(id, outcome.pose, fullPose(liveTool));
      return;
    }
    if (resolution.kind === 'attach') {
      if (!submitOps([planHang(liveTool, resolution.target)], 'hang').ok) return;
      const hung = currentWall()?.items.find((item) => item.id === id);
      if (hung) glideTo(id, outcome.pose, fullPose(hung));
      return;
    }
    const ops: LeafOp[] = [
      ...(liveTool.parentId === undefined
        ? []
        : [{ type: 'attachItem', id, parentId: null } satisfies LeafOp]),
      {
        type: 'moveItem',
        id,
        // Snap on (Alt inverts it) keeps tools on lattice cells like every other item: they stay nudgeable and copyable.
        to:
          editorStore.get().snap !== outcome.free
            ? { cell: nearestCell(live.board, outcome.pose.x, outcome.pose.y) }
            : { x: outcome.pose.x, y: outcome.pose.y },
      },
    ];
    submitOps(ops, 'move-item');
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

/** The rotation as one op: a holder turns its hanging tools with it, anything else just turns. */
function rotationOp(wall: Wall | null, id: string, rotZ: number): Op {
  const item = wall?.items.find((candidate) => candidate.id === id);
  if (wall && item?.kind === 'holder') return planRotateHolder(wall, id, rotZ);
  return { type: 'rotateItem', id, rotZ };
}

/** Live poses of a rotation drag; `valid` is false when a locked tool on the holder blocks the turn. */
function rotationPreview(
  id: string,
  rotZ: number,
): { readonly poses: Map<string, PreviewPose>; readonly valid: boolean } {
  const wall = currentWall();
  const item = wall?.items.find((candidate) => candidate.id === id);
  if (!wall || !item) return { poses: new Map(), valid: true };
  try {
    return { poses: posesAfter(wall, rotationOp(wall, id, rotZ)), valid: true };
  } catch (error) {
    if (!(error instanceof OpError)) throw error;
    return { poses: new Map([[id, { x: item.pose.x, y: item.pose.y, rotZ }]]), valid: false };
  }
}

/** Rotation handle drag: angle of the pointer around the item's centre, snapped to the lattice symmetry. */
export function beginRotateDrag(itemId: string, event: PointerPress): void {
  const native = event.nativeEvent;
  const wall = currentWall();
  const item = wall?.items.find((candidate) => candidate.id === itemId);
  if (!wall || !item || item.locked || native.button !== 0) return;
  event.stopPropagation();
  cancelSnap();
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
    const preview = rotationPreview(itemId, lastRot);
    patchEditor({ dragging: preview.poses, dragValid: preview.valid });
  };
  const onUp = (): void => {
    finish();
    if (lastRot === startRot) return;
    const live = currentWall();
    try {
      submitOps([rotationOp(live, itemId, lastRot)], 'rotate-item');
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
    }
  };
  const onCancel = (): void => finish();
  globalThis.addEventListener('pointermove', onMove);
  globalThis.addEventListener('pointerup', onUp);
  globalThis.addEventListener('pointercancel', onCancel);
  patchEditor({ holding: true });
}
