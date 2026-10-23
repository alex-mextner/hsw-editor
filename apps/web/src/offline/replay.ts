/**
 * Sends a wall's queued edits to the daemon, in order, each with `baseRev`.
 *
 * The first request is optimistic: it goes out against the rev this device last saw. If the wall moved
 * on, the daemon answers `409 rev_conflict` and the body carries its current wall; the queue is then
 * reconciled against that wall (`reconcile.ts`). No conflict: replay silently on top of it. Conflicts, or a
 * daemon whose wall is *older* than ours (restored backup): ask the caller (`strategy` is `undefined`), which
 * is where the "rebase / keep mine / keep theirs" dialog hooks in; a chosen strategy is applied and remembered
 * for the rest of this replay.
 *
 * The record lives in a `ReplayStore` (the editor's `LiveRecord`) and every step is a function of its *current*
 * value, so edits the user makes while the replay runs are kept, not overwritten by a stale copy. After every
 * acknowledged edit the store persists, so a crash or a lost connection in the middle never replays an edit
 * twice or loses one (an edit whose acknowledgement was lost is recognised as already applied on the next run).
 */
import type { Actor, ApplyResponse, Wall } from '@hsw-editor/core';
import { assertNever } from './assertNever.ts';
import {
  planReplay,
  resolvePlan,
  type DroppedEdit,
  type ReplayPlan,
  type Strategy,
} from './reconcile.ts';
import type { QueuedEdit, WallRecord } from './record.ts';

export type TransportResult<T> =
  | { readonly kind: 'ok'; readonly value: T }
  /** The daemon is unreachable (offline, restarting, gateway 502/503/504). */
  | { readonly kind: 'network' }
  /** `409 rev_conflict`; `wall` is the daemon's current wall. */
  | { readonly kind: 'conflict'; readonly wall: Wall }
  /** The wall no longer exists (`404`). */
  | { readonly kind: 'gone' }
  /** The daemon refused this request for good (`4xx` other than the above, e.g. `422 op_failed`). */
  | { readonly kind: 'rejected'; readonly code: string; readonly message: string }
  /** Anything else (`5xx`); retrying later may work. */
  | { readonly kind: 'error'; readonly message: string };

export interface ReplayTransport {
  applyOps(
    wallId: string,
    edit: QueuedEdit,
    baseRev: number,
    actor: Actor,
  ): Promise<TransportResult<ApplyResponse>>;
}

/** The live record the replay reads and updates (`LiveRecord` implements it). */
export interface ReplayStore {
  read(): WallRecord;
  update(change: (record: WallRecord) => WallRecord): Promise<void>;
}

export type ReplayOutcome =
  /** Queue is empty; `applied` edits were accepted. */
  | {
      readonly kind: 'synced';
      readonly record: WallRecord;
      readonly applied: number;
      readonly dropped: readonly DroppedEdit[];
      readonly restored: readonly string[];
    }
  /** Conflicting edits (or a rolled-back daemon) and no strategy given: nothing was changed, ask the user. */
  | {
      readonly kind: 'needs-decision';
      readonly record: WallRecord;
      /** The daemon's wall the plan was made against. */
      readonly server: Wall;
      readonly plan: ReplayPlan;
    }
  /** Connection lost; the remaining queue is persisted and stays valid. */
  | { readonly kind: 'offline'; readonly record: WallRecord; readonly applied: number }
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly record: WallRecord; readonly message: string };

export interface ReplayOptions {
  readonly store: ReplayStore;
  readonly transport: ReplayTransport;
  /** Chosen by the user after a `needs-decision` outcome; `undefined` = ask on conflict. */
  readonly strategy?: Strategy;
}

/** Conflicts that keep appearing mean the other side is editing as fast as we replay. */
const MAX_ROUNDS = 6;

function acknowledge(record: WallRecord, editId: number, response: ApplyResponse): WallRecord {
  return {
    ...record,
    wall: response.wall,
    canUndo: response.canUndo,
    canRedo: response.canRedo,
    edits: record.edits.filter((edit) => edit.id !== editId),
  };
}

export async function replayQueue(options: ReplayOptions): Promise<ReplayOutcome> {
  const { store, transport, strategy } = options;
  let applied = 0;
  const dropped: DroppedEdit[] = [];
  const restored: string[] = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let conflictWall: Wall | undefined;

    for (let record = store.read(); record.edits[0]; record = store.read()) {
      const head = record.edits[0];
      const result = await transport.applyOps(record.wall.id, head, record.wall.rev, record.actor);
      switch (result.kind) {
        case 'ok':
          applied += 1;
          await store.update((current) => acknowledge(current, head.id, result.value));
          break;
        case 'conflict':
          conflictWall = result.wall;
          break;
        case 'network':
          return { kind: 'offline', record: store.read(), applied };
        case 'gone':
          return { kind: 'gone' };
        case 'rejected':
          dropped.push({
            edit: head,
            reason: 'rejected',
            code: result.code,
            message: result.message,
          });
          await store.update((current) => ({
            ...current,
            edits: current.edits.filter((edit) => edit.id !== head.id),
          }));
          break;
        case 'error':
          return { kind: 'failed', record: store.read(), message: result.message };
        default:
          return assertNever(result);
      }
      if (conflictWall) break;
    }

    if (!conflictWall) {
      return { kind: 'synced', record: store.read(), applied, dropped, restored };
    }

    const record = store.read();
    const planned = record.edits;
    const plan = planReplay(record.wall, planned, conflictWall);
    if ((plan.conflicts.length > 0 || plan.diverged) && strategy === undefined) {
      return { kind: 'needs-decision', record, server: conflictWall, plan };
    }
    const resolution = resolvePlan(record.wall, planned, conflictWall, strategy ?? 'rebase');
    dropped.push(...resolution.dropped.filter((entry) => entry.reason !== 'redundant'));
    restored.push(...resolution.restored);
    // Persist the resolved queue on top of the daemon's wall before sending anything: whatever happens next
    // (network loss, reload), the stored record is the decision, not the old conflict. Edits made since the
    // plan was taken are kept after the resolved ones. The undo/redo flags are left as they were: the daemon's
    // stack is unknown until the next response.
    const plannedIds = new Set(planned.map((edit) => edit.id));
    await store.update((current) => ({
      ...current,
      wall: conflictWall,
      edits: [...resolution.send, ...current.edits.filter((edit) => !plannedIds.has(edit.id))],
    }));
  }
  return {
    kind: 'failed',
    record: store.read(),
    message: 'the wall keeps changing on the server; try again',
  };
}
