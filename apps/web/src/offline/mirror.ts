/**
 * The offline mirror of walls: one `WallRecord` per wall in a `KvStore`, plus the pure helpers the editor
 * uses to evolve a record (record an edit, take a server wall) and `LiveRecord`, the in-memory holder of the
 * open wall's record that everything (the editor recording edits, the replay acknowledging them) updates.
 *
 * Writes of one wall are serialized and coalesced: while a write is in flight only the newest record
 * waits, so a burst of edits costs two IndexedDB transactions, not one per keystroke, and the stored
 * record is always the latest one (never an older write landing after a newer one). A failed write does not
 * strand the newest record: it is still written, and the caller of `put` hears about the last failure.
 */
import type { Actor, Op, Wall, WallSummary } from '@hsw-editor/core';
import type { KvStore } from './kv.ts';
import { flattenOps, type QueuedEdit, type WallRecord, WALL_RECORD_VERSION } from './record.ts';

/** Mirrored walls kept besides those with unsent edits; the oldest beyond this are dropped. */
export const DEFAULT_MIRROR_LIMIT = 30;

export interface UndoFlags {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function newRecord(wall: Wall, actor: Actor, flags: UndoFlags, savedAt: number): WallRecord {
  return {
    v: WALL_RECORD_VERSION,
    wall,
    canUndo: flags.canUndo,
    canRedo: flags.canRedo,
    edits: [],
    nextEditId: 1,
    actor,
    savedAt,
  };
}

/**
 * Appends `ops` as one queued edit made on the record's current server wall. An edit with no operations is
 * not recorded (the record is returned as is): the stored queue must always be readable back. A lone `batch`
 * keeps its label as the undo-step name.
 */
export function enqueueEdit(
  record: WallRecord,
  ops: readonly Op[],
  label: string | undefined,
  at: number,
): WallRecord {
  const leaves = flattenOps(ops);
  if (leaves.length === 0) return record;
  const [first] = ops;
  const name = label ?? (ops.length === 1 && first?.type === 'batch' ? first.label : undefined);
  const edit: QueuedEdit = {
    id: record.nextEditId,
    ops: leaves,
    ...(name === undefined ? {} : { label: name }),
    baseRev: record.wall.rev,
    at,
  };
  return {
    ...record,
    edits: [...record.edits, edit],
    nextEditId: record.nextEditId + 1,
    savedAt: at,
  };
}

/**
 * A newer server wall (SSE, refetch) becomes the record's base, but only while nothing is queued. With edits
 * queued the base is the wall they were made on and must stay: reconciliation compares it with what the daemon
 * has now, and moving it would hide exactly what the other side changed. The open editor keeps the newer wall
 * in memory for display; the replay takes care of the rest.
 */
export function withServerWall(record: WallRecord, wall: Wall, flags: UndoFlags): WallRecord {
  if (record.edits.length > 0) return record;
  return { ...record, wall, canUndo: flags.canUndo, canRedo: flags.canRedo };
}

/**
 * The live record of the open wall. Every change is a function of the *current* record (`update`), so
 * an edit the user makes while a replay is acknowledging earlier ones is never overwritten by a stale copy:
 * both go through the same holder and each sees the other's result. The holder stamps `savedAt`.
 */
export class LiveRecord {
  private current: WallRecord;

  constructor(
    initial: WallRecord,
    private readonly persist: (record: WallRecord) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.current = initial;
  }

  read(): WallRecord {
    return this.current;
  }

  /** Applies `change` to the current record at once and persists the result. */
  update(change: (record: WallRecord) => WallRecord): Promise<void> {
    this.current = { ...change(this.current), savedAt: this.now() };
    return this.persist(this.current);
  }
}

/** One row of the wall list when the daemon is unreachable. */
export interface MirroredWall {
  /** `updatedAt` is when this device last saved the wall, not when the daemon last changed it. */
  readonly summary: WallSummary;
  /** Edits made offline that the daemon has not accepted yet. */
  readonly queued: number;
}

export class WallMirror {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly waiting = new Map<string, WallRecord>();

  constructor(private readonly store: KvStore<WallRecord>) {}

  get(wallId: string): Promise<WallRecord | undefined> {
    return this.store.get(wallId);
  }

  /** Stores `record`; resolves when it (or a newer record for the same wall) has been written. */
  put(record: WallRecord): Promise<void> {
    const id = record.wall.id;
    const running = this.inflight.get(id);
    if (running) {
      this.waiting.set(id, record);
      return running;
    }
    const run: Promise<void> = this.write(id, record).finally(() => {
      if (this.inflight.get(id) === run) this.inflight.delete(id);
    });
    this.inflight.set(id, run);
    return run;
  }

  /** Writes `record`, then whatever newer record queued up meanwhile; the failure of the last write is thrown. */
  private async write(id: string, first: WallRecord): Promise<void> {
    let record: WallRecord | undefined = first;
    let failure: { readonly error: unknown } | undefined;
    while (record) {
      try {
        await this.store.set(id, record);
        failure = undefined;
      } catch (error) {
        failure = { error };
      }
      record = this.waiting.get(id);
      this.waiting.delete(id);
    }
    if (failure) throw failure.error;
  }

  /** Resolves when every write accepted so far has landed. */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight.values()]);
    }
  }

  async remove(wallId: string): Promise<void> {
    this.waiting.delete(wallId);
    await this.store.delete(wallId);
  }

  /** Mirrored walls, newest first. */
  async list(): Promise<MirroredWall[]> {
    const entries = await this.store.entries();
    return entries
      .map(([, record]) => record)
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((record) => ({
        summary: {
          id: record.wall.id,
          name: record.wall.name,
          rev: record.wall.rev,
          items: record.wall.items.length,
          photos: record.wall.photos.length,
          models: record.wall.models.length,
          updatedAt: new Date(record.savedAt).toISOString(),
        },
        queued: record.edits.length,
      }));
  }

  /**
   * Drops the oldest mirrored walls beyond `limit`. A wall with unsent edits is never dropped: each delete
   * re-checks the stored record inside one transaction, so an edit queued between the scan and the delete
   * (by this or another tab) keeps its wall.
   */
  async prune(limit = DEFAULT_MIRROR_LIMIT): Promise<string[]> {
    const entries = await this.store.entries();
    const candidates = entries
      .filter(([key, record]) => record.edits.length === 0 && !this.inflight.has(key))
      .sort(([, a], [, b]) => b.savedAt - a.savedAt)
      .slice(limit);
    const removed: string[] = [];
    for (const [key] of candidates) {
      if (await this.store.deleteIf(key, (current) => current.edits.length === 0))
        removed.push(key);
    }
    return removed;
  }
}
