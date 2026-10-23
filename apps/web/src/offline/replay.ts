/**
 * Sends a wall's queued edits to the daemon, in order, each with `baseRev`.
 *
 * The first request is optimistic: it goes out against the rev this device last saw. If the wall moved
 * on, the daemon answers `409 rev_conflict` and the body carries its current wall; the queue is then
 * reconciled against that wall (`reconcile.ts`). No conflict: replay silently on top of it. Conflicts, or a
 * daemon whose wall is *older* than ours (restored backup): the outcome is `needs-decision` with the daemon's
 * rev; the caller shows the "rebase / keep mine / keep theirs" dialog and calls again with a `decision` for
 * *that* rev. A decision is only applied to the conflict it was made for: if the daemon has moved on by then,
 * the user is asked again instead of getting a strategy applied to changes they never saw.
 *
 * The record lives in a `ReplayStore` (the editor's `LiveRecord`) and every step is a function of its *current*
 * value, so edits the user makes while the replay runs are kept, not overwritten by a stale copy. After every
 * acknowledged edit the store persists, so a crash or a lost connection in the middle never replays an edit
 * twice or loses one. One replay runs per store at a time: a second call while one is running joins it.
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

/** The user's answer to a `needs-decision`: a strategy for the daemon state (`serverRev`) they were shown. */
export interface Decision {
  readonly strategy: Strategy;
  readonly serverRev: number;
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
  /** Conflicting edits (or a rolled-back daemon) and no matching decision: nothing was changed, ask the user. */
  | {
      readonly kind: 'needs-decision';
      readonly record: WallRecord;
      /** The daemon's wall the plan was made against; answer with `decision.serverRev = server.rev`. */
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
  /** The user's answer to an earlier `needs-decision`. */
  readonly decision?: Decision;
}

/** Conflicts that keep appearing mean the other side is editing as fast as we replay. */
const MAX_ROUNDS = 6;

const running = new WeakMap<ReplayStore, Promise<ReplayOutcome>>();

function withoutEdit(record: WallRecord, editId: number): WallRecord {
  return { ...record, edits: record.edits.filter((edit) => edit.id !== editId) };
}

function acknowledge(record: WallRecord, editId: number, response: ApplyResponse): WallRecord {
  return {
    ...withoutEdit(record, editId),
    wall: response.wall,
    canUndo: response.canUndo,
    canRedo: response.canRedo,
  };
}

type Drained =
  | { readonly kind: 'empty' }
  | { readonly kind: 'conflict'; readonly wall: Wall }
  | { readonly kind: 'stop'; readonly outcome: ReplayOutcome };

class Replay {
  private applied = 0;
  private readonly dropped: DroppedEdit[] = [];
  private readonly restored: string[] = [];

  constructor(private readonly options: ReplayOptions) {}

  async run(): Promise<ReplayOutcome> {
    const { store } = this.options;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const drained = await this.drain();
      if (drained.kind === 'stop') return drained.outcome;
      if (drained.kind === 'empty') {
        return {
          kind: 'synced',
          record: store.read(),
          applied: this.applied,
          dropped: this.dropped,
          restored: this.restored,
        };
      }
      const question = await this.resolve(drained.wall);
      if (question) return question;
    }
    return {
      kind: 'failed',
      record: store.read(),
      message: 'the wall keeps changing on the server; try again',
    };
  }

  /** Sends edits from the head until the queue is empty, the daemon says 409, or something stops the replay. */
  private async drain(): Promise<Drained> {
    const { store, transport } = this.options;
    for (let record = store.read(); ; record = store.read()) {
      const head = record.edits[0];
      if (!head) return { kind: 'empty' };
      const result = await transport.applyOps(record.wall.id, head, record.wall.rev, record.actor);
      switch (result.kind) {
        case 'ok':
          this.applied += 1;
          await store.update((current) => acknowledge(current, head.id, result.value));
          break;
        case 'conflict':
          return { kind: 'conflict', wall: result.wall };
        case 'network':
          return {
            kind: 'stop',
            outcome: { kind: 'offline', record: store.read(), applied: this.applied },
          };
        case 'gone':
          return { kind: 'stop', outcome: { kind: 'gone' } };
        case 'rejected':
          this.dropped.push({
            edit: head,
            reason: 'rejected',
            code: result.code,
            message: result.message,
          });
          await store.update((current) => withoutEdit(current, head.id));
          break;
        case 'error':
          return {
            kind: 'stop',
            outcome: { kind: 'failed', record: store.read(), message: result.message },
          };
        default:
          return assertNever(result);
      }
    }
  }

  /**
   * Reconciles the queue with the daemon's wall. Returns the `needs-decision` outcome when the user has to
   * answer; otherwise persists the resolved queue on top of the daemon's wall and returns `undefined`.
   */
  private async resolve(server: Wall): Promise<ReplayOutcome | undefined> {
    const { store, decision } = this.options;
    const record = store.read();
    const plan = planReplay(record.wall, record.edits, server);
    // A decision answers one specific conflict: the daemon state the user was shown.
    const strategy = decision?.serverRev === server.rev ? decision.strategy : undefined;
    if ((plan.conflicts.length > 0 || plan.diverged) && strategy === undefined) {
      return { kind: 'needs-decision', record, server, plan };
    }
    const resolution = resolvePlan(record.wall, record.edits, server, strategy ?? 'rebase');
    this.dropped.push(...resolution.dropped);
    this.restored.push(...resolution.restored);
    // Persist the resolved queue on top of the daemon's wall before sending anything: whatever happens next
    // (network loss, reload), the stored record is the decision, not the old conflict. Edits made since the
    // plan was taken are kept after the resolved ones. The undo/redo flags are left as they were: the daemon's
    // stack is unknown until the next response.
    const plannedIds = new Set(record.edits.map((edit) => edit.id));
    await store.update((current) => ({
      ...current,
      wall: server,
      edits: [...resolution.send, ...current.edits.filter((edit) => !plannedIds.has(edit.id))],
    }));
    return undefined;
  }
}

export function replayQueue(options: ReplayOptions): Promise<ReplayOutcome> {
  const existing = running.get(options.store);
  if (existing) return existing;
  const replay = new Replay(options).run().finally(() => {
    running.delete(options.store);
  });
  running.set(options.store, replay);
  return replay;
}
