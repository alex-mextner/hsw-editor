/**
 * Offline reconciliation: my queued edits (made on `base`) against the server's wall now (`server`).
 *
 * Every edit is classified by replaying it with the core reducer on top of the server wall:
 *   - `redundant`    applying it changes nothing: the server already has this result (e.g. my own edit
 *                    whose acknowledgement was lost, or the other side made the same move);
 *   - `clean`        applies and touches nothing the server side changed since `base`;
 *   - `overlap`      applies, but writes a field the server side also changed (mine would overwrite theirs);
 *   - `inapplicable` the reducer refuses it (the item was removed or locked by the other side).
 *
 * The user's answer is one of three strategies:
 *   - `rebase`     replay mine on top of theirs; edits the reducer refuses are dropped;
 *   - `keepMine`   like `rebase`, and additionally bring back an item/photo/model the other side removed
 *                  when one of my edits needs it (restored as I last saw it);
 *   - `keepTheirs` drop every edit that overlaps or no longer applies; clean ones still go through.
 * Without conflicts all three are identical, so no question is asked.
 */
import { applyOp, OpError, type OpErrorCode, type LeafOp, type Wall } from '@hsw-editor/core';
import { assertNever } from './assertNever.ts';
import { diffFootprint, opFootprint, overlappingEntities, subtractFootprint } from './footprint.ts';
import { editToOp, type QueuedEdit } from './record.ts';

export const STRATEGIES = ['rebase', 'keepMine', 'keepTheirs'] as const;
export type Strategy = (typeof STRATEGIES)[number];

export type EditStatus = 'clean' | 'redundant' | 'overlap' | 'inapplicable';

export interface PlannedEdit {
  readonly edit: QueuedEdit;
  readonly status: EditStatus;
  /** Entities (`item:i-1`, ...) both sides wrote; non-empty for `overlap`. */
  readonly overlapping: readonly string[];
  /** Reducer error for `inapplicable`. */
  readonly code?: OpErrorCode;
  readonly message?: string;
}

export interface ReplayPlan {
  readonly edits: readonly PlannedEdit[];
  /** Edits the user has to decide about: `overlap` and `inapplicable`. */
  readonly conflicts: readonly PlannedEdit[];
  /** The server wall is older than the one the queue is based on (reset, restored backup). */
  readonly diverged: boolean;
}

export interface DroppedEdit {
  readonly edit: QueuedEdit;
  readonly reason: 'redundant' | 'overlap' | 'inapplicable' | 'rejected';
  readonly code?: string;
  readonly message?: string;
}

export interface Resolution {
  readonly strategy: Strategy;
  /** Edits to send, in order; `ops` may start with restore ops (`keepMine`). */
  readonly send: readonly QueuedEdit[];
  readonly dropped: readonly DroppedEdit[];
  /** Entities re-added for `keepMine`, e.g. `item:i-1`. */
  readonly restored: readonly string[];
  /** The wall after sending `send` on top of the server wall (revs are not advanced). */
  readonly wall: Wall;
}

interface Attempt {
  readonly wall: Wall;
  readonly changed: boolean;
}

function tryApply(
  wall: Wall,
  ops: readonly LeafOp[],
  label: string | undefined,
): Attempt | OpError {
  try {
    const result = applyOp(wall, editToOp({ ops, ...(label === undefined ? {} : { label }) }));
    return { wall: result.wall, changed: result.changed };
  } catch (error) {
    if (error instanceof OpError) return error;
    throw error;
  }
}

/** Ids an edit refers to, by entity kind, so a removed one can be restored from my own view. */
function referencedEntities(ops: readonly LeafOp[]): {
  items: string[];
  photos: string[];
  models: string[];
} {
  const items: string[] = [];
  const photos: string[] = [];
  const models: string[] = [];
  for (const op of ops) {
    switch (op.type) {
      case 'moveItem':
      case 'rotateItem':
      case 'setParams':
      case 'setVariant':
      case 'lock':
      case 'attachItem':
        items.push(op.id);
        break;
      case 'rename':
        if (op.itemId !== undefined) items.push(op.itemId);
        break;
      case 'setCalibration':
        photos.push(op.photoId);
        break;
      case 'updateModelRef':
        models.push(op.id);
        break;
      case 'addItem':
      case 'removeItem':
      case 'addPhoto':
      case 'removePhoto':
      case 'setBoard':
      case 'addModelRef':
      case 'removeModelRef':
        break;
      default:
        return assertNever(op);
    }
  }
  return { items, photos, models };
}

/** `addItem`/`addPhoto`/`addModelRef` ops re-creating what `edit` needs and `view` lost, taken from `mine`. */
function restoreOps(
  view: Wall,
  mine: Wall,
  ops: readonly LeafOp[],
): { ops: LeafOp[]; entities: string[] } {
  const wanted = referencedEntities(ops);
  const restore: LeafOp[] = [];
  const entities: string[] = [];
  for (const id of new Set(wanted.items)) {
    const item = mine.items.find((candidate) => candidate.id === id);
    if (item && !view.items.some((candidate) => candidate.id === id)) {
      restore.push({ type: 'addItem', item });
      entities.push(`item:${id}`);
    }
  }
  for (const id of new Set(wanted.photos)) {
    const photo = mine.photos.find((candidate) => candidate.id === id);
    if (photo && !view.photos.some((candidate) => candidate.id === id)) {
      restore.push({ type: 'addPhoto', photo });
      entities.push(`photo:${id}`);
    }
  }
  for (const id of new Set(wanted.models)) {
    const model = mine.models.find((candidate) => candidate.id === id);
    if (model && !view.models.some((candidate) => candidate.id === id)) {
      restore.push({ type: 'addModelRef', model });
      entities.push(`model:${id}`);
    }
  }
  return { ops: restore, entities };
}

/**
 * The edit only creates/removes entities and `view` already has exactly that outcome: the typical case is
 * my own `addItem` whose acknowledgement was lost, replayed after a reload. The reducer refuses it
 * (`item_exists`); it is satisfied, not conflicting. Identity is the id plus what the user placed.
 */
function alreadyApplied(view: Wall, ops: readonly LeafOp[]): boolean {
  return ops.every((op) => {
    switch (op.type) {
      case 'addItem': {
        const found = view.items.find((item) => item.id === op.item.id);
        if (!found) return false;
        const placed = (item: typeof found) => [item.kind, item.bankId, item.variantId, item.cell];
        return JSON.stringify(placed(found)) === JSON.stringify(placed(op.item));
      }
      case 'removeItem':
        return !view.items.some((item) => item.id === op.id);
      case 'addPhoto':
        return view.photos.some((photo) => photo.id === op.photo.id);
      case 'removePhoto':
        return !view.photos.some((photo) => photo.id === op.id);
      case 'addModelRef':
        return view.models.some((model) => model.id === op.model.id);
      case 'removeModelRef':
        return !view.models.some((model) => model.id === op.id);
      case 'moveItem':
      case 'rotateItem':
      case 'setParams':
      case 'setVariant':
      case 'lock':
      case 'attachItem':
      case 'rename':
      case 'setCalibration':
      case 'setBoard':
      case 'updateModelRef':
        return false;
      default:
        return assertNever(op);
    }
  });
}

interface Walked {
  readonly planned: PlannedEdit[];
  readonly send: QueuedEdit[];
  readonly dropped: DroppedEdit[];
  readonly restored: string[];
  readonly wall: Wall;
}

/** One pass over the queue under `strategy`; the plan is the same walk under `rebase`. */
function walk(base: Wall, edits: readonly QueuedEdit[], server: Wall, strategy: Strategy): Walked {
  // What the other side changed. Shrinks when one of my edits turns out to be already on the server.
  let theirs = diffFootprint(base, server);
  const planned: PlannedEdit[] = [];
  const send: QueuedEdit[] = [];
  const dropped: DroppedEdit[] = [];
  const restored: string[] = [];
  let view = server;
  // The wall as the user who made the edits sees it: the source of truth for `keepMine` restores.
  let mine = base;

  const redundant = (edit: QueuedEdit): void => {
    planned.push({ edit, status: 'redundant', overlapping: [] });
    dropped.push({ edit, reason: 'redundant' });
    // Its effect on the server is mine, not theirs: later edits of mine must not conflict with it.
    theirs = subtractFootprint(theirs, opFootprint(edit.ops));
  };

  for (const edit of edits) {
    const overlapping = overlappingEntities(opFootprint(edit.ops), theirs);
    const attempt = tryApply(view, edit.ops, edit.label);
    const myBefore = mine;
    if (strategy === 'keepMine') {
      const mineAttempt = tryApply(mine, edit.ops, edit.label);
      if (!(mineAttempt instanceof OpError)) mine = mineAttempt.wall;
    }

    if (!(attempt instanceof OpError)) {
      if (!attempt.changed) {
        redundant(edit);
        continue;
      }
      if (overlapping.length === 0) {
        planned.push({ edit, status: 'clean', overlapping: [] });
      } else {
        planned.push({ edit, status: 'overlap', overlapping });
        if (strategy === 'keepTheirs') {
          dropped.push({ edit, reason: 'overlap' });
          continue;
        }
      }
      view = attempt.wall;
      send.push(edit);
      continue;
    }

    if (alreadyApplied(view, edit.ops)) {
      redundant(edit);
      continue;
    }

    planned.push({
      edit,
      status: 'inapplicable',
      overlapping,
      code: attempt.code,
      message: attempt.message,
    });
    if (strategy === 'keepMine') {
      const restore = restoreOps(view, myBefore, edit.ops);
      const ops = [...restore.ops, ...edit.ops];
      const retry = restore.ops.length > 0 ? tryApply(view, ops, edit.label) : attempt;
      if (!(retry instanceof OpError)) {
        view = retry.wall;
        restored.push(...restore.entities);
        send.push({ ...edit, ops });
        continue;
      }
    }
    dropped.push({ edit, reason: 'inapplicable', code: attempt.code, message: attempt.message });
  }
  return { planned, send, dropped, restored, wall: view };
}

/** Classifies `edits` (made on `base`) against the server wall; asks nothing, changes nothing. */
export function planReplay(base: Wall, edits: readonly QueuedEdit[], server: Wall): ReplayPlan {
  const { planned } = walk(base, edits, server, 'rebase');
  return {
    edits: planned,
    conflicts: planned.filter((p) => p.status === 'overlap' || p.status === 'inapplicable'),
    diverged: server.rev < base.rev,
  };
}

/** What to send for `strategy`; the result is deterministic, so the UI can preview it. */
export function resolvePlan(
  base: Wall,
  edits: readonly QueuedEdit[],
  server: Wall,
  strategy: Strategy,
): Resolution {
  const { send, dropped, restored, wall } = walk(base, edits, server, strategy);
  return { strategy, send, dropped, restored, wall };
}
