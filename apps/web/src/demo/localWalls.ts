/**
 * The wall service of the demo build (no daemon): walls live in this page, the same contract the daemon answers (`SyncApi`, create,
 * clone, delete, list), so `WallSync` and the wall switcher are unchanged. One wall is the template (the bundled demo wall, rebuilt on
 * every load, never saved); every other wall is a clone or a new wall of the visitor, written to IndexedDB (the offline mirror's store) by this class only, after
 * every change, so it is still there after a reload. Undo history is per session: a reloaded wall starts with an empty history.
 *
 * The store is shared by every tab of the page and this class is its only writer: before it answers or changes a wall it compares
 * the revision it holds with the stored one, and a stored wall that moved on (another tab edited it) is taken over, so a tab never
 * acts on, or writes back, a wall older than the one on disk.
 */
import {
  applyOp,
  checkWall,
  createEmptyWall,
  DEFAULT_BOARD,
  newId,
  OpError,
  WallSchema,
  type Board,
  type Op,
  type Wall,
  type WallSummary,
} from '@hsw-editor/core';
import { ApiError } from '@/api/http.ts';
import type { ChangeEntry, OpResponse, WallResponse } from '@/api/schemas.ts';
import { newRecord, type MirroredWall } from '@/offline/mirror.ts';
import type { WallRecord } from '@/offline/record.ts';
import { cloneOf } from '@/wall/fork.ts';

/** Where the visitor's walls survive a reload (the offline mirror). */
export interface StoredWalls {
  get(id: string): Promise<WallRecord | undefined>;
  list(): Promise<MirroredWall[]>;
  put(record: WallRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

interface Entry {
  readonly op: Op;
  readonly inverse: Op;
  /** Revision the op created: what an undo or redo of it refers to. */
  readonly rev: number;
}

interface Slot {
  wall: Wall;
  undo: Entry[];
  redo: Entry[];
  /** What was applied since the wall was opened, oldest first (the timeline). */
  history: ChangeEntry[];
  /** Written to storage at least once: a record missing after that was deleted by another tab. */
  stored: boolean;
}

/** Runs `job` with no other tab (or call) in the middle of it: the check of a wall's stored revision and the write that follows it. */
export type Exclusive = <T>(job: () => Promise<T>) => Promise<T>;

/** One lock for the page's walls, shared by every tab of the origin (Web Locks); without the API there is no other tab to wait for. */
export const pageExclusive: Exclusive = (job) => {
  const locks = globalThis.navigator?.locks;
  return locks === undefined ? job() : locks.request('hsw-demo-walls', job);
};

/** The longest wall name the daemon accepts, and so the longest a record is read back with (`WallSchema`). */
const MAX_NAME = 200;

function checkName(name: string): void {
  if (name.length > MAX_NAME)
    throw failure(400, 'invalid_name', `a wall name is at most ${MAX_NAME} characters`);
}

function failure(status: number, code: string, message: string, wall?: Wall): ApiError {
  const body =
    wall === undefined
      ? { error: { code, message } }
      : { error: { code, message }, wall, currentRev: wall.rev };
  return new ApiError(status, code, message, body);
}

/** Several ops are one undo step, as the daemon stores them. */
function combine(ops: readonly Op[], label: string | undefined): Op {
  const [only] = ops;
  if (ops.length === 1 && only !== undefined) return only;
  const leaves = ops.flatMap((op) => (op.type === 'batch' ? op.ops : [op]));
  return { type: 'batch', ops: leaves, ...(label === undefined ? {} : { label }) };
}

function summaryOf(wall: Wall, updatedAt: string, template: boolean): WallSummary {
  return {
    id: wall.id,
    name: wall.name,
    rev: wall.rev,
    items: wall.items.length,
    photos: wall.photos.length,
    models: wall.models.length,
    updatedAt,
    ...(template ? { template: true } : {}),
  };
}

/** What a slot held before a change, to put back when the change cannot be saved. */
function snapshotOf(slot: Slot): Pick<Slot, 'wall' | 'undo' | 'redo' | 'history'> {
  return {
    wall: slot.wall,
    undo: [...slot.undo],
    redo: [...slot.redo],
    history: [...slot.history],
  };
}

export class LocalWalls {
  private readonly slots = new Map<string, Slot>();
  private readonly loading = new Map<string, Promise<Slot>>();
  /** Storage writes, one after another: a wall's last write never lands after the delete that follows it. */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly templateId: string,
    private readonly template: () => Promise<Wall>,
    private readonly stored: StoredWalls,
    private readonly now: () => Date = () => new Date(),
    private readonly exclusive: Exclusive = pageExclusive,
  ) {}

  private slot(id: string): Promise<Slot> {
    const known = this.slots.get(id);
    if (known) return Promise.resolve(known);
    // Reads that overlap share one slot: a second, separate one would be skipped by the saves of the first.
    const loading = this.loading.get(id);
    if (loading) return loading;
    const load = this.loadSlot(id).finally(() => this.loading.delete(id));
    this.loading.set(id, load);
    return load;
  }

  private async loadSlot(id: string): Promise<Slot> {
    const isTemplate = id === this.templateId;
    const wall = isTemplate ? await this.template() : (await this.stored.get(id))?.wall;
    if (wall === undefined) throw failure(404, 'wall_not_found', `wall ${id} does not exist`);
    const slot: Slot = { wall, undo: [], redo: [], history: [], stored: !isTemplate };
    this.slots.set(id, slot);
    return slot;
  }

  /**
   * Brings this tab's copy of the wall up to the stored one: a stored revision ahead of ours means another tab edited it, so its wall
   * replaces ours (and our undo history, which no longer applies) and is returned; a stored record that is gone after it was written
   * means another tab deleted the wall. An older stored revision is our own write still on its way and changes nothing.
   */
  private async takeOverNewer(id: string, slot: Slot): Promise<Wall | null> {
    if (id === this.templateId) return null;
    const record = await this.stored.get(id);
    if (record === undefined) {
      if (!slot.stored) return null;
      this.slots.delete(id);
      throw failure(404, 'wall_not_found', `wall ${id} was deleted`);
    }
    if (record.wall.rev <= slot.wall.rev) return null;
    slot.wall = record.wall;
    slot.undo = [];
    slot.redo = [];
    slot.history = [];
    return slot.wall;
  }

  /** A change made in another tab: the edit is refused as a revision conflict that carries the stored wall (the editor reconciles). */
  private async refuseIfMovedOn(id: string, slot: Slot): Promise<void> {
    const wall = await this.takeOverNewer(id, slot);
    if (wall !== null) {
      throw failure(409, 'rev_conflict', `wall ${id} was changed in another tab`, wall);
    }
  }

  /** The first write of a new wall; when it fails the wall is not kept, so a retry starts clean instead of finding it "existing". */
  private async saveNew(id: string, slot: Slot): Promise<void> {
    try {
      await this.save(id, slot);
    } catch (error) {
      this.slots.delete(id);
      throw error;
    }
  }

  /** Saves the changed slot; when the write fails (storage full) the slot goes back to `before`, so memory never holds what disk lacks. */
  private async commit(
    id: string,
    slot: Slot,
    before: Pick<Slot, 'wall' | 'undo' | 'redo' | 'history'>,
  ): Promise<void> {
    try {
      await this.save(id, slot);
    } catch (error) {
      Object.assign(slot, before);
      throw error;
    }
  }

  /** Writes the wall as it is now to storage (unless it was deleted meanwhile), after the writes before it. */
  private save(id: string, slot: Slot): Promise<void> {
    if (id === this.templateId) return Promise.resolve();
    const record = newRecord(
      slot.wall,
      { kind: 'human' },
      { canUndo: slot.undo.length > 0, canRedo: slot.redo.length > 0 },
      this.now().getTime(),
    );
    const job = this.writes.then(async () => {
      if (this.slots.get(id) !== slot) return;
      await this.stored.put(record);
      slot.stored = true;
    });
    this.writes = job.catch(() => undefined);
    return job;
  }

  private response(id: string, slot: Slot): WallResponse {
    return {
      wall: slot.wall,
      canUndo: slot.undo.length > 0,
      canRedo: slot.redo.length > 0,
      warnings: checkWall(slot.wall),
      ...(id === this.templateId ? { template: true } : {}),
    };
  }

  private async exists(id: string): Promise<boolean> {
    return (
      id === this.templateId || this.slots.has(id) || (await this.stored.get(id)) !== undefined
    );
  }

  async list(): Promise<WallSummary[]> {
    const at = this.now().toISOString();
    const walls = new Map<string, WallSummary>();
    walls.set(this.templateId, summaryOf((await this.slot(this.templateId)).wall, at, true));
    for (const { summary } of await this.stored.list()) {
      if (!walls.has(summary.id)) walls.set(summary.id, summary);
    }
    // A wall made a moment ago may not be stored yet: the one in memory stands in until it is.
    for (const [id, slot] of this.slots) {
      if (id !== this.templateId && !slot.stored && !walls.has(id)) {
        walls.set(id, summaryOf(slot.wall, at, false));
      }
    }
    return [...walls.values()];
  }

  async get(id: string): Promise<WallResponse> {
    const slot = await this.slot(id);
    await this.takeOverNewer(id, slot);
    return this.response(id, slot);
  }

  async history(id: string, since: number, limit: number): Promise<ChangeEntry[]> {
    const slot = await this.slot(id);
    await this.takeOverNewer(id, slot);
    return slot.history.filter((entry) => entry.rev > since).slice(0, limit);
  }

  async create(input: { name: string; id?: string; board?: Board }): Promise<Wall> {
    checkName(input.name);
    return this.exclusive(() => this.createLocked(input));
  }

  private async createLocked(input: { name: string; id?: string; board?: Board }): Promise<Wall> {
    const id = input.id ?? newId('w');
    if (await this.exists(id)) throw failure(409, 'wall_exists', `wall ${id} already exists`);
    const wall = createEmptyWall(id, input.name, input.board ?? DEFAULT_BOARD);
    const slot: Slot = { wall, undo: [], redo: [], history: [], stored: false };
    this.slots.set(id, slot);
    await this.saveNew(id, slot);
    return wall;
  }

  /** A copy of `sourceId` under a new id and name, with a fresh history (what the first edit of the template makes). */
  async clone(sourceId: string, input: { id: string; name: string }): Promise<Wall> {
    checkName(input.name);
    return this.exclusive(() => this.cloneLocked(sourceId, input));
  }

  private async cloneLocked(sourceId: string, input: { id: string; name: string }): Promise<Wall> {
    const source = await this.slot(sourceId);
    if (await this.exists(input.id)) {
      throw failure(409, 'wall_exists', `wall ${input.id} already exists`);
    }
    const wall = cloneOf(source.wall, input.id, input.name);
    const slot: Slot = { wall, undo: [], redo: [], history: [], stored: false };
    this.slots.set(input.id, slot);
    await this.saveNew(input.id, slot);
    return wall;
  }

  remove(id: string): Promise<void> {
    if (id === this.templateId) {
      return Promise.reject(failure(403, 'demo_unavailable', 'the demo wall is kept'));
    }
    return this.exclusive(async () => {
      this.slots.delete(id);
      const job = this.writes.then(() => this.stored.remove(id));
      this.writes = job.catch(() => undefined);
      await job;
    });
  }

  apply(
    id: string,
    ops: readonly Op[],
    baseRev: number | undefined,
    label: string | undefined,
  ): Promise<OpResponse> {
    return this.exclusive(() => this.applyLocked(id, ops, baseRev, label));
  }

  private async applyLocked(
    id: string,
    ops: readonly Op[],
    baseRev: number | undefined,
    label: string | undefined,
  ): Promise<OpResponse> {
    const slot = await this.slot(id);
    await this.refuseIfMovedOn(id, slot);
    this.checkRev(slot, baseRev);
    const op = combine(ops, label);
    try {
      const result = applyOp(slot.wall, op);
      if (!result.changed) return this.outcome(id, slot, op, result.inverse, false);
      // What is saved must read back: the editor does not parse ops the way the daemon does, so a text past a limit stops here.
      if (!WallSchema.safeParse(result.wall).success) {
        throw failure(422, 'op_failed', 'the edit makes the wall invalid');
      }
      const before = snapshotOf(slot);
      slot.wall = result.wall;
      slot.undo.push({ op, inverse: result.inverse, rev: result.wall.rev });
      slot.redo = [];
      this.record(slot, { kind: 'op', op, inverse: result.inverse, label });
      await this.commit(id, slot, before);
      return this.outcome(id, slot, op, result.inverse, true);
    } catch (error) {
      if (error instanceof OpError) throw failure(422, 'op_failed', error.message);
      throw error;
    }
  }

  undo(id: string, baseRev: number | undefined): Promise<OpResponse> {
    return this.exclusive(() => this.step(id, baseRev, 'undo'));
  }

  redo(id: string, baseRev: number | undefined): Promise<OpResponse> {
    return this.exclusive(() => this.step(id, baseRev, 'redo'));
  }

  private async step(
    id: string,
    baseRev: number | undefined,
    way: 'undo' | 'redo',
  ): Promise<OpResponse> {
    const slot = await this.slot(id);
    await this.refuseIfMovedOn(id, slot);
    this.checkRev(slot, baseRev);
    const before = snapshotOf(slot);
    const from = way === 'undo' ? slot.undo : slot.redo;
    const entry = from.pop();
    if (entry === undefined) throw failure(409, `nothing_to_${way}`, `nothing to ${way}`);
    const op = way === 'undo' ? entry.inverse : entry.op;
    try {
      const result = applyOp(slot.wall, op);
      // Undo and redo always move the revision forward, even when the step changes nothing.
      slot.wall = result.changed ? result.wall : { ...result.wall, rev: slot.wall.rev + 1 };
      (way === 'undo' ? slot.redo : slot.undo).push(entry);
      this.record(slot, { kind: way, op, inverse: result.inverse, ref: entry.rev });
      await this.commit(id, slot, before);
      return this.outcome(id, slot, op, result.inverse, true);
    } catch (error) {
      Object.assign(slot, before);
      if (error instanceof OpError) throw failure(409, `${way}_conflict`, error.message);
      throw error;
    }
  }

  private record(
    slot: Slot,
    change: {
      readonly kind: ChangeEntry['kind'];
      readonly op: Op;
      readonly inverse: Op;
      readonly ref?: number;
      readonly label?: string | undefined;
    },
  ): void {
    slot.history.push({
      kind: change.kind,
      rev: slot.wall.rev,
      ts: this.now().toISOString(),
      actor: { kind: 'human' },
      op: change.op,
      inverse: change.inverse,
      ...(change.ref === undefined ? {} : { ref: change.ref }),
      ...(change.label === undefined ? {} : { label: change.label }),
    });
  }

  private checkRev(slot: Slot, baseRev: number | undefined): void {
    if (baseRev !== undefined && baseRev !== slot.wall.rev) {
      throw failure(
        409,
        'rev_conflict',
        `wall is at rev ${slot.wall.rev}, request was based on rev ${baseRev}`,
        slot.wall,
      );
    }
  }

  private outcome(id: string, slot: Slot, op: Op, inverse: Op, changed: boolean): OpResponse {
    const { wall, canUndo, canRedo, warnings } = this.response(id, slot);
    return { rev: wall.rev, changed, op, inverse, wall, warnings, canUndo, canRedo };
  }
}
