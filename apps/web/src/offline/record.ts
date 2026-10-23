/**
 * The persisted offline record of one wall: the last server state this device knows (`wall`, the
 * "base" every queued edit sits on) plus the edits made on top of it that the server has not
 * acknowledged yet. One record per wall, written in one IndexedDB put, so a crash can never leave
 * the base and the queue out of step.
 *
 * Queued edits reuse the core op types: replaying them goes through the same `applyOp` reducer the
 * daemon runs, so offline editing has no second set of op semantics.
 */
import {
  ActorSchema,
  applyOp,
  LeafOpSchema,
  OpError,
  type Actor,
  type LeafOp,
  type Op,
  WallSchema,
  type Wall,
} from '@hsw-editor/core';

export const WALL_RECORD_VERSION = 1;

export interface QueuedEdit {
  /** Monotonic per wall; stable across reloads, used to talk about one edit in the UI. */
  readonly id: number;
  /** Flat leaf ops sent as one request: one rev, one undo step. */
  readonly ops: readonly LeafOp[];
  readonly label?: string;
  /** Rev of the server wall this edit was made against (informational; replay rebases on the live rev). */
  readonly baseRev: number;
  /** Epoch ms the edit was made. */
  readonly at: number;
}

export interface WallRecord {
  readonly v: typeof WALL_RECORD_VERSION;
  /** Last server state this device has seen; the queue is based on it. */
  readonly wall: Wall;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly edits: readonly QueuedEdit[];
  readonly nextEditId: number;
  /** Identity the edits are replayed under (stable across reloads, unlike a tab-session name). */
  readonly actor: Actor;
  /** Epoch ms of the last write; orders the mirror for pruning. */
  readonly savedAt: number;
}

/** Flattens `batch` ops: a queued edit is always a flat list of leaves. */
export function flattenOps(ops: readonly Op[]): LeafOp[] {
  return ops.flatMap((op) => (op.type === 'batch' ? op.ops : [op]));
}

/** The single op a queued edit is sent as (the leaf itself, or a `batch` carrying the label). */
export function editToOp(edit: Pick<QueuedEdit, 'ops' | 'label'>): Op {
  const [only] = edit.ops;
  if (edit.ops.length === 1 && only) return only;
  return {
    type: 'batch',
    ops: [...edit.ops],
    ...(edit.label === undefined ? {} : { label: edit.label }),
  };
}

export interface FoldResult {
  readonly wall: Wall;
  /** Ids of edits the reducer refused against the evolving view (they are skipped in `wall`). */
  readonly refused: readonly number[];
}

/** `base` with every edit re-applied in order; an edit that no longer applies is skipped, not fatal. */
export function foldEdits(base: Wall, edits: readonly QueuedEdit[]): FoldResult {
  let view = base;
  const refused: number[] = [];
  for (const edit of edits) {
    try {
      view = applyOp(view, editToOp(edit)).wall;
    } catch (error) {
      if (!(error instanceof OpError)) throw error;
      refused.push(edit.id);
    }
  }
  return { wall: view, refused };
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isEpochMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRecordObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function parseEdit(raw: unknown): QueuedEdit | undefined {
  if (!isRecordObject(raw)) return undefined;
  const { id, ops, label, baseRev, at } = raw;
  if (!isInt(id) || !isInt(baseRev) || !isEpochMs(at)) return undefined;
  if (!Array.isArray(ops) || ops.length === 0) return undefined;
  if (label !== undefined && typeof label !== 'string') return undefined;
  const leaves: LeafOp[] = [];
  for (const op of ops) {
    const parsed = LeafOpSchema.safeParse(op);
    if (!parsed.success) return undefined;
    leaves.push(parsed.data);
  }
  return { id, ops: leaves, ...(label === undefined ? {} : { label }), baseRev, at };
}

/** Validates a record read from storage; `undefined` for anything this build cannot trust. */
export function parseWallRecord(raw: unknown): WallRecord | undefined {
  if (!isRecordObject(raw)) return undefined;
  const { v, wall, actor, edits: rawEdits, canUndo, canRedo, nextEditId, savedAt } = raw;
  if (v !== WALL_RECORD_VERSION || !Array.isArray(rawEdits)) return undefined;
  const parsedWall = WallSchema.safeParse(wall);
  const parsedActor = ActorSchema.safeParse(actor);
  if (!parsedWall.success || !parsedActor.success) return undefined;
  const edits: QueuedEdit[] = [];
  for (const rawEdit of rawEdits) {
    const edit = parseEdit(rawEdit);
    // A queue with an unreadable edit cannot be replayed faithfully: refuse the whole record
    // rather than silently dropping one of the user's edits.
    if (!edit) return undefined;
    edits.push(edit);
  }
  if (typeof canUndo !== 'boolean' || typeof canRedo !== 'boolean') return undefined;
  if (!isInt(nextEditId) || !isEpochMs(savedAt)) return undefined;
  return {
    v: WALL_RECORD_VERSION,
    wall: parsedWall.data,
    canUndo,
    canRedo,
    edits,
    nextEditId,
    actor: parsedActor.data,
    savedAt,
  };
}
