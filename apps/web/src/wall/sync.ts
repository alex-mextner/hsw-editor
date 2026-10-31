/**
 * Optimistic edit pipeline for one open wall.
 *
 * `confirmed` is the last wall state known to the server. User edits queue as `pending` and are shown
 * immediately: `view = fold(applyOp, confirmed, pending)` with the same pure reducer the server runs.
 * Edits are sent one at a time with `baseRev`; the server's answer or an SSE event moves `confirmed`
 * forward and the pending edits are re-applied on top (rebase). A refused edit is dropped, which
 * rolls the view back to the server state, and a notice explains why.
 */
import {
  applyOp,
  checkWall,
  withoutFloorWarnings,
  OpError,
  type Actor,
  type LeafOp,
  type Op,
  type Wall,
  type WallWarning,
} from '@hsw-editor/core';
import { ApiError, NetworkError } from '@/api/http.ts';
import { newRecord } from '@/offline/mirror.ts';
import { planReplay, resolvePlan, type ReplayPlan, type Strategy } from '@/offline/reconcile.ts';
import type { QueuedEdit, WallRecord } from '@/offline/record.ts';
import {
  ConflictResponseSchema,
  type ChangeEntry,
  type OpResponse,
  type WallResponse,
} from '@/api/schemas.ts';

export interface SyncApi {
  getWall(id: string): Promise<WallResponse>;
  applyOps(id: string, ops: readonly Op[], baseRev: number, label?: string): Promise<OpResponse>;
  undo(id: string, baseRev?: number): Promise<OpResponse>;
  redo(id: string, baseRev?: number): Promise<OpResponse>;
}

export type SyncStatus = 'loading' | 'ready' | 'offline' | 'error' | 'deleted';

export interface Notice {
  readonly id: number;
  readonly kind: 'rejected' | 'conflict' | 'error' | 'remote';
  /** Server error code or reducer code, for i18n lookups. */
  readonly code: string;
  readonly message: string;
}

export interface RemoteEdit {
  readonly actor: Actor;
  readonly rev: number;
  readonly at: number;
}

/** Offline persistence of the open wall (IndexedDB mirror); optional so the sync works without it. */
export interface OfflineStore {
  load(wallId: string): Promise<WallRecord | undefined>;
  save(record: WallRecord): void;
}

/** Queued edits that clash with what changed on the daemon meanwhile; the user decides (`resolveConflict`). */
export interface SyncConflict {
  readonly plan: ReplayPlan;
  readonly serverRev: number;
}

export interface SyncState {
  readonly wallId: string;
  readonly status: SyncStatus;
  /** What the editor shows: confirmed state plus pending edits. */
  readonly wall: Wall | null;
  readonly confirmedRev: number;
  readonly pending: number;
  readonly warnings: readonly WallWarning[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly lastRemote: RemoteEdit | null;
  readonly notice: Notice | null;
  readonly errorMessage: string | null;
  /** Set while the queue waits for the user's decision; nothing is sent meanwhile. */
  readonly conflict: SyncConflict | null;
}

type PendingEdit =
  | {
      readonly id: number;
      readonly kind: 'ops';
      readonly ops: readonly LeafOp[];
      readonly label?: string;
      /** Server rev this edit was made against, and when (epoch ms): persisted with the offline queue. */
      readonly baseRev: number;
      readonly at: number;
    }
  | { readonly id: number; readonly kind: 'undo' | 'redo' };

export type SubmitResult = { readonly ok: true } | { readonly ok: false; readonly error: OpError };

const MAX_CONFLICT_RETRIES = 5;
const OFFLINE_RETRY_MS = 2000;

function flatten(ops: readonly Op[]): LeafOp[] {
  return ops.flatMap((op) => (op.type === 'batch' ? op.ops : [op]));
}

function asOp(ops: readonly LeafOp[], label?: string): Op {
  const [only] = ops;
  if (ops.length === 1 && only) return only;
  return { type: 'batch', ops: [...ops], ...(label === undefined ? {} : { label }) };
}

export class WallSync {
  private readonly listeners = new Set<() => void>();
  private confirmed: Wall | null = null;
  private pending: PendingEdit[] = [];
  private nextId = 1;
  private noticeId = 1;
  private flushing = false;
  private flushRun: Promise<void> = Promise.resolve();
  private disposed = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private state: SyncState;

  constructor(
    readonly wallId: string,
    private readonly api: SyncApi,
    private readonly actor: Actor,
    private readonly now: () => number = Date.now,
    private readonly offline: OfflineStore | null = null,
  ) {
    this.state = {
      wallId,
      status: 'loading',
      wall: null,
      confirmedRev: 0,
      pending: 0,
      warnings: [],
      canUndo: false,
      canRedo: false,
      lastRemote: null,
      notice: null,
      errorMessage: null,
      conflict: null,
    };
  }

  // ---- store contract (useSyncExternalStore) -----------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): SyncState => this.state;

  /**
   * The wall the queued edits were made on. Reconciliation compares it with the daemon's wall after a 409, so it must stay
   * the old base while edits are queued and is only dropped once the queue is empty.
   */
  private queueBase: Wall | null = null;

  /** Writes the confirmed wall and the queued edits to the offline mirror (undo/redo steps are not persisted). */
  private persist(): void {
    const base = this.queueBase ?? this.confirmed;
    if (this.disposed || !this.offline || !base) return;
    const edits = this.queuedOps();
    this.offline.save({
      ...newRecord(
        base,
        this.actor,
        { canUndo: this.state.canUndo, canRedo: this.state.canRedo },
        this.now(),
      ),
      edits,
      nextEditId: this.nextId,
    });
  }

  private publish(patch: Partial<SyncState> = {}): void {
    if (this.pending.length === 0) this.queueBase = null;
    const view = this.fold();
    this.state = {
      ...this.state,
      ...patch,
      wall: view,
      confirmedRev: this.confirmed?.rev ?? 0,
      pending: this.pending.length,
      warnings: view ? withoutFloorWarnings(view, checkWall(view)) : [],
    };
    this.persist();
    for (const listener of [...this.listeners]) listener();
  }

  private notice(kind: Notice['kind'], code: string, message: string): void {
    this.state = { ...this.state, notice: { id: this.noticeId++, kind, code, message } };
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer ?? undefined);
    this.listeners.clear();
  }

  // ---- loading and remote events -----------------------------------------------------------------

  async load(): Promise<void> {
    try {
      const response = await this.api.getWall(this.wallId);
      const stored = await this.offline?.load(this.wallId).catch(() => undefined);
      if (stored && stored.edits.length > 0) {
        // Edits queued before a reload or a crash: take them back on the wall they were made on, then reconcile with
        // the daemon's current wall (silently when nothing clashes, with the conflict dialog otherwise).
        this.pending = stored.edits.map((edit) => ({ ...edit, kind: 'ops' as const }));
        this.nextId = stored.nextEditId;
        this.queueBase = stored.wall;
        this.confirmed = stored.wall;
        this.state = { ...this.state, canUndo: response.canUndo, canRedo: response.canRedo };
        this.publish({ status: 'ready', errorMessage: null });
        if (this.reconcile(response.wall)) this.flush();
        return;
      }
      this.confirmed = response.wall;
      this.publish({
        status: 'ready',
        canUndo: response.canUndo,
        canRedo: response.canRedo,
        errorMessage: null,
      });
      this.flush();
    } catch (error) {
      if (error instanceof NetworkError && (await this.restoreFromMirror())) return;
      this.fail(error);
    }
  }

  /** The daemon is down at start-up: open the last mirrored wall with its queued edits, read/write, offline. */
  private async restoreFromMirror(): Promise<boolean> {
    const record = await this.offline?.load(this.wallId).catch(() => undefined);
    if (!record) return false;
    this.confirmed = record.wall;
    this.queueBase = record.edits.length > 0 ? record.wall : null;
    this.pending = record.edits.map((edit) => ({ ...edit, kind: 'ops' as const }));
    this.nextId = record.nextEditId;
    this.publish({
      status: 'offline',
      canUndo: record.canUndo,
      canRedo: record.canRedo,
      errorMessage: null,
    });
    this.scheduleRetry();
    return true;
  }

  /** Resolves when every queued edit has been sent (or sending stopped, e.g. offline). */
  async idle(): Promise<void> {
    while (this.flushing) await this.flushRun;
  }

  /** Full state from the server (SSE `snapshot`, resync after a gap or reconnect). */
  applySnapshot(wall: Wall): void {
    if (this.confirmed && wall.rev < this.confirmed.rev) return;
    this.confirmed = wall;
    this.publish({ status: 'ready', errorMessage: null });
  }

  /**
   * The wall a photo/model upload answered with: the server applied one `add*` op, so it is undoable. The SSE
   * echo of that op arrives at (or below) this rev and is ignored, hence the history flags are set here.
   */
  acceptUploaded(wall: Wall): void {
    if (this.confirmed && wall.rev <= this.confirmed.rev) return;
    this.confirmed = wall;
    this.publish({ status: 'ready', errorMessage: null, canUndo: true, canRedo: false });
  }

  /** One SSE `op` event; foreign edits show up live, own echoes are recognised by rev and ignored. */
  applyRemote(entry: ChangeEntry): Promise<void> {
    const confirmed = this.confirmed;
    if (!confirmed || entry.rev <= confirmed.rev) return Promise.resolve();
    if (entry.rev !== confirmed.rev + 1) return this.resync();
    try {
      const next = applyOp(confirmed, entry.op).wall;
      if (next.rev !== entry.rev) throw new Error('rev mismatch');
      this.confirmed = next;
    } catch {
      return this.resync();
    }
    const own = entry.actor.kind === this.actor.kind && entry.actor.name === this.actor.name;
    this.publish({
      ...(own ? {} : { lastRemote: { actor: entry.actor, rev: entry.rev, at: this.now() } }),
      ...(entry.kind === 'op' ? { canUndo: true, canRedo: false } : {}),
    });
    return entry.kind === 'op' ? Promise.resolve() : this.refreshHistoryFlags();
  }

  markDeleted(): void {
    this.publish({ status: 'deleted' });
  }

  async resync(): Promise<void> {
    try {
      const response = await this.api.getWall(this.wallId);
      // A GET that started before an upload/ack answered must not move the wall back in time.
      if (this.confirmed && response.wall.rev < this.confirmed.rev) return;
      this.confirmed = response.wall;
      this.publish({
        status: 'ready',
        canUndo: response.canUndo,
        canRedo: response.canRedo,
        errorMessage: null,
      });
      this.flush();
    } catch (error) {
      this.fail(error);
    }
  }

  private async refreshHistoryFlags(): Promise<void> {
    try {
      const response = await this.api.getWall(this.wallId);
      if (this.disposed) return;
      this.publish({ canUndo: response.canUndo, canRedo: response.canRedo });
    } catch {
      // Flags are advisory; the next event refreshes them.
    }
  }

  // ---- editing -----------------------------------------------------------------------------------

  /**
   * Applies `ops` optimistically as ONE undo step. Refused locally (and nothing queued) when the
   * reducer rejects them against the current view, e.g. a locked item.
   */
  submit(ops: readonly Op[], label?: string): SubmitResult {
    const view = this.fold();
    if (!view) return { ok: false, error: new OpError('invalid_op', 'wall is not loaded') };
    const leaves = flatten(ops);
    if (leaves.length === 0) return { ok: true };
    try {
      const result = applyOp(view, asOp(leaves, label));
      if (!result.changed) return { ok: true };
    } catch (error) {
      if (error instanceof OpError) return { ok: false, error };
      throw error;
    }
    // The base of the queue is the wall its first edit was made on; undo/redo steps in the queue count too.
    this.queueBase ??= this.confirmed;
    this.pending.push({
      id: this.nextId++,
      kind: 'ops',
      ops: leaves,
      ...(label === undefined ? {} : { label }),
      baseRev: this.confirmed?.rev ?? 0,
      at: this.now(),
    });
    this.publish({ canUndo: true, canRedo: false });
    this.flush();
    return { ok: true };
  }

  undo(): void {
    this.pending.push({ id: this.nextId++, kind: 'undo' });
    this.publish();
    this.flush();
  }

  redo(): void {
    this.pending.push({ id: this.nextId++, kind: 'redo' });
    this.publish();
    this.flush();
  }

  // ---- internals ---------------------------------------------------------------------------------

  /** Confirmed wall with every queued edit re-applied; edits that no longer apply are skipped. */
  private fold(): Wall | null {
    let view = this.confirmed;
    if (!view) return null;
    for (const edit of this.pending) {
      if (edit.kind !== 'ops') continue;
      try {
        view = applyOp(view, asOp(edit.ops, edit.label)).wall;
      } catch (error) {
        if (!(error instanceof OpError)) throw error;
      }
    }
    return view;
  }

  private flush(): void {
    if (this.flushing || this.disposed || this.state.conflict) return;
    this.flushing = true;
    this.flushRun = this.runFlush();
  }

  private async runFlush(): Promise<void> {
    let conflicts = 0;
    try {
      while (!this.disposed) {
        const head = this.pending[0];
        const confirmed = this.confirmed;
        if (!head || !confirmed) break;
        // Remote edits arrived (SSE) while edits were queued: reconcile before sending so they are never overwritten blindly.
        if (this.queueMovedOn(head, confirmed)) {
          if (!this.reconcile(confirmed)) break;
          continue;
        }
        try {
          const response = await this.sendRequest(head, confirmed.rev);
          this.pending.shift();
          conflicts = 0;
          this.onAck(head, response, confirmed.rev);
        } catch (error) {
          const outcome = this.onSendError(head, error, conflicts);
          if (outcome === 'retry') conflicts += 1;
          else if (outcome === 'stop') break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private queueMovedOn(head: PendingEdit, confirmed: Wall): boolean {
    return head.kind === 'ops' && this.queueBase !== null && confirmed.rev !== this.queueBase.rev;
  }

  private sendRequest(head: PendingEdit, rev: number): Promise<OpResponse> {
    if (head.kind === 'ops') return this.api.applyOps(this.wallId, head.ops, rev, head.label);
    return head.kind === 'undo' ? this.api.undo(this.wallId, rev) : this.api.redo(this.wallId, rev);
  }

  private onAck(head: PendingEdit, response: OpResponse, sentRev: number): void {
    // The remaining edits were made on top of this one: the daemon's answer is their new base, unless a remote edit
    // interleaved (then the answer is more than one rev ahead). Our own SSE echo may already have moved `confirmed`.
    if (this.queueBase?.rev === sentRev && response.wall.rev === sentRev + 1) {
      this.queueBase = response.wall;
    }
    if (!this.confirmed || response.wall.rev >= this.confirmed.rev) this.confirmed = response.wall;
    this.publish({ status: 'ready', canUndo: response.canUndo, canRedo: response.canRedo });
  }

  /** Decides what to do after a failed send: retry the same head, drop it, or stop the loop. */
  private onSendError(
    head: PendingEdit,
    error: unknown,
    conflictsSoFar: number,
  ): 'retry' | 'dropped' | 'stop' {
    if (error instanceof NetworkError) {
      this.publish({ status: 'offline' });
      this.scheduleRetry();
      return 'stop';
    }
    if (error instanceof ApiError && error.isConflict) {
      const body = ConflictResponseSchema.safeParse(error.body);
      if (body.success && body.data.wall && conflictsSoFar < MAX_CONFLICT_RETRIES) {
        return this.reconcile(body.data.wall) ? 'retry' : 'stop';
      }
    }
    if (error instanceof ApiError) {
      this.pending.shift();
      const kind = error.status === 409 || error.status === 422 ? 'rejected' : 'error';
      this.notice(kind, error.code, error.message);
      this.publish();
      return 'dropped';
    }
    this.pending.shift();
    this.notice('error', 'unexpected', error instanceof Error ? error.message : String(error));
    this.publish();
    return 'dropped';
  }

  private conflictServer: Wall | null = null;

  private queuedOps(): QueuedEdit[] {
    return this.pending.flatMap((edit) =>
      edit.kind === 'ops'
        ? [
            {
              id: edit.id,
              ops: edit.ops,
              ...(edit.label === undefined ? {} : { label: edit.label }),
              baseRev: edit.baseRev,
              at: edit.at,
            },
          ]
        : [],
    );
  }

  /**
   * The daemon's wall moved while edits were queued (409). Edits that touch nothing the other side changed are replayed on
   * top silently; a real clash (same field, an item removed or locked meanwhile) or a daemon older than our base stops the
   * queue and asks the user (`conflict`). Returns whether sending may go on.
   */
  private reconcile(server: Wall): boolean {
    const base = this.queueBase ?? this.confirmed;
    const edits = this.queuedOps();
    if (!base || edits.length === 0) {
      this.confirmed = server;
      this.publish();
      return true;
    }
    const plan = planReplay(base, edits, server);
    if (plan.conflicts.length > 0 || plan.diverged) {
      this.conflictServer = server;
      this.publish({ conflict: { plan, serverRev: server.rev } });
      return false;
    }
    this.applyResolution(base, edits, server, 'rebase');
    return true;
  }

  private applyResolution(
    base: Wall,
    edits: readonly QueuedEdit[],
    server: Wall,
    strategy: Strategy,
  ): void {
    const resolution = resolvePlan(base, edits, server, strategy);
    const kept = new Map(
      resolution.send.map((edit) => [
        edit.id,
        {
          id: edit.id,
          kind: 'ops' as const,
          ops: edit.ops,
          ...(edit.label === undefined ? {} : { label: edit.label }),
          baseRev: server.rev,
          at: edit.at,
        },
      ]),
    );
    // Original order is kept: an undo or redo step stays where it was between the edits.
    this.pending = this.pending.flatMap((edit): PendingEdit[] => {
      if (edit.kind !== 'ops') return [edit];
      const replacement = kept.get(edit.id);
      return replacement ? [replacement] : [];
    });
    this.confirmed = server;
    this.queueBase = this.pending.length > 0 ? server : null;
    this.conflictServer = null;
    this.publish({ conflict: null });
    if (resolution.dropped.length > 0) {
      this.notice(
        'rejected',
        'dropped',
        resolution.dropped.map((entry) => entry.message ?? entry.reason).join('; '),
      );
      this.publish();
    }
  }

  /** The user's answer to `state.conflict`: apply the strategy to the daemon state they were shown and carry on. */
  resolveConflict(strategy: Strategy): void {
    const server = this.conflictServer;
    const base = this.queueBase;
    if (!server || !base || this.state.conflict?.serverRev !== server.rev) return;
    this.applyResolution(base, this.queuedOps(), server, strategy);
    this.flush();
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.disposed) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.resync();
    }, OFFLINE_RETRY_MS);
  }

  private fail(error: unknown): void {
    if (error instanceof NetworkError) {
      this.publish({ status: 'offline', errorMessage: error.message });
      this.scheduleRetry();
    } else if (error instanceof ApiError && error.status === 404) {
      this.publish({ status: 'deleted', errorMessage: error.message });
    } else {
      this.publish({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
