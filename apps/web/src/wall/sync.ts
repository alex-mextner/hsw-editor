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
  OpError,
  type Actor,
  type LeafOp,
  type Op,
  type Wall,
  type WallWarning,
} from '@hsw-editor/core';
import { ApiError, NetworkError } from '@/api/http.ts';
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
}

type PendingEdit =
  | {
      readonly id: number;
      readonly kind: 'ops';
      readonly ops: readonly LeafOp[];
      readonly label?: string;
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

  private publish(patch: Partial<SyncState> = {}): void {
    const view = this.fold();
    this.state = {
      ...this.state,
      ...patch,
      wall: view,
      confirmedRev: this.confirmed?.rev ?? 0,
      pending: this.pending.length,
      warnings: view ? checkWall(view) : [],
    };
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
    this.pending.push({
      id: this.nextId++,
      kind: 'ops',
      ops: leaves,
      ...(label === undefined ? {} : { label }),
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
    if (this.flushing || this.disposed) return;
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
        try {
          const response =
            head.kind === 'ops'
              ? await this.api.applyOps(this.wallId, head.ops, confirmed.rev, head.label)
              : head.kind === 'undo'
                ? await this.api.undo(this.wallId, confirmed.rev)
                : await this.api.redo(this.wallId, confirmed.rev);
          this.pending.shift();
          conflicts = 0;
          this.onAck(head, response);
        } catch (error) {
          const outcome = this.onSendError(head, error, conflicts);
          if (outcome === 'retry') {
            conflicts += 1;
            continue;
          }
          if (outcome === 'stop') break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private onAck(head: PendingEdit, response: OpResponse): void {
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
        this.confirmed = body.data.wall;
        this.publish();
        return 'retry';
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
