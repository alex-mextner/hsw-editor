/**
 * Offline reconciliation: my queued edits (made on `base`) against the server's wall now (`server`).
 *
 * Every edit is classified by replaying it with the core reducer on top of the server wall:
 *   - `redundant`    the server already has this result: applying it changes nothing, or (an edit that creates
 *                    entities) the entities it touches already look exactly as the edit leaves them. The typical
 *                    case is my own edit whose acknowledgement was lost;
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
 *
 * Known limit: "redundant" cannot tell my own lost acknowledgement from another actor making the very same change;
 * both are treated as mine, so a later edit of mine on that field is not reported as a conflict with it.
 */
import { applyOp, OpError, type LeafOp, type OpErrorCode, type Wall } from '@hsw-editor/core';
import { assertNever } from './assertNever.ts';
import { deepEqual } from './equal.ts';
import {
  diffFootprint,
  entityKey,
  opFootprint,
  overlappingEntities,
  subtractFootprint,
  type EntityKind,
} from './footprint.ts';
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

/** An edit that did not go through, and why. `redundant` edits are not listed: there is nothing to tell the user. */
export interface DroppedEdit {
  readonly edit: QueuedEdit;
  readonly reason: 'overlap' | 'inapplicable' | 'rejected';
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

interface Ref {
  readonly kind: Exclude<EntityKind, 'wall'>;
  readonly id: string;
}

/** Entities an edit refers to without creating them, so a removed one can be restored from my own view. */
function references(ops: readonly LeafOp[]): Ref[] {
  const refs: Ref[] = [];
  for (const op of ops) {
    switch (op.type) {
      case 'moveItem':
      case 'rotateItem':
      case 'setParams':
      case 'setVariant':
      case 'lock':
      case 'attachItem':
        refs.push({ kind: 'item', id: op.id });
        break;
      case 'rename':
        if (op.itemId !== undefined) refs.push({ kind: 'item', id: op.itemId });
        break;
      case 'setCalibration':
        refs.push({ kind: 'photo', id: op.photoId });
        break;
      case 'updateModelRef':
        refs.push({ kind: 'model', id: op.id });
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
  return refs;
}

/** The stored entity (item, photo or model) with this id, or `undefined`. */
function entityOf(wall: Wall, kind: Ref['kind'], id: string): object | undefined {
  switch (kind) {
    case 'item':
      return wall.items.find((item) => item.id === id);
    case 'photo':
      return wall.photos.find((photo) => photo.id === id);
    case 'model':
      return wall.models.find((model) => model.id === id);
    default:
      return assertNever(kind);
  }
}

/** Ops re-creating what `ops` needs and `view` lost, taken from `mine`. */
function restoreOps(
  view: Wall,
  mine: Wall,
  ops: readonly LeafOp[],
): { ops: LeafOp[]; entities: string[] } {
  const restore: LeafOp[] = [];
  const entities: string[] = [];
  const seen = new Set<string>();
  for (const { kind, id } of references(ops)) {
    const key = entityKey(kind, id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (entityOf(view, kind, id) !== undefined) continue;
    const mineItem = kind === 'item' ? mine.items.find((item) => item.id === id) : undefined;
    const minePhoto = kind === 'photo' ? mine.photos.find((photo) => photo.id === id) : undefined;
    const mineModel = kind === 'model' ? mine.models.find((model) => model.id === id) : undefined;
    if (mineItem) restore.push({ type: 'addItem', item: mineItem });
    else if (minePhoto) restore.push({ type: 'addPhoto', photo: minePhoto });
    else if (mineModel) restore.push({ type: 'addModelRef', model: mineModel });
    else continue;
    entities.push(key);
  }
  return { ops: restore, entities };
}

/** The stored state of an entity key (`item:i-1`, `wall:`), for comparing two walls entity by entity. */
function stateOf(wall: Wall, key: string): unknown {
  const separator = key.indexOf(':');
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  switch (kind) {
    case 'item':
    case 'photo':
    case 'model':
      return entityOf(wall, kind, id);
    case 'wall':
      return { name: wall.name, board: wall.board };
    default:
      return undefined;
  }
}

/**
 * The server already looks the way this edit leaves things: every entity the edit touches is, on the server,
 * exactly as it would be after applying the edit to my own view. A lost acknowledgement of a batch such as
 * `[addItem n, attachItem n]` is the case this exists for (the reducer refuses it with `item_exists`).
 */
function satisfiedOnServer(
  view: Wall,
  expected: Attempt | OpError,
  ops: readonly LeafOp[],
): boolean {
  if (expected instanceof OpError) return false;
  return [...opFootprint(ops).keys()].every((key) =>
    deepEqual(stateOf(view, key), stateOf(expected.wall, key)),
  );
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
  // The wall as the user who made the edits sees it: what "already applied" is measured against and
  // what `keepMine` restores from.
  let mine = base;

  const redundant = (edit: QueuedEdit): void => {
    planned.push({ edit, status: 'redundant', overlapping: [] });
    // Its effect on the server is mine, not theirs: later edits of mine must not conflict with it.
    theirs = subtractFootprint(theirs, opFootprint(edit.ops));
  };

  for (const edit of edits) {
    const overlapping = overlappingEntities(opFootprint(edit.ops), theirs);
    const attempt = tryApply(view, edit.ops, edit.label);
    const myBefore = mine;
    const expected = tryApply(mine, edit.ops, edit.label);
    if (!(expected instanceof OpError)) mine = expected.wall;

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

    if (satisfiedOnServer(view, expected, edit.ops)) {
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
