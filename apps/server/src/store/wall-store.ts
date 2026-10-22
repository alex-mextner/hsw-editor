/**
 * Wall store: the daemon is the single writer of `<home>/walls/<id>/{wall.json,history.jsonl,photos/,models/}`.
 *
 * Durability protocol for every change: append the history entry (fsync) FIRST, then atomically replace
 * wall.json. History is therefore always >= the snapshot, and after a crash `load` rebuilds the wall by
 * replaying the history tail onto wall.json (or from the `create` entry when wall.json is lost). A torn
 * last history line is dropped and truncated. Undo/redo are ordinary history entries that apply stored
 * inverse ops, so every actor's edits live in one linear stream.
 */
import { mkdir, readdir, readFile, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  type Actor,
  applyOp,
  type ApplyResult,
  type Board,
  type ChangeEntry,
  checkWall,
  createEmptyWall,
  DEFAULT_BOARD,
  type HistoryEntry,
  type InputRequest,
  InputRequestSchema,
  HistoryEntrySchema,
  ID_PATTERN,
  type JsonValue,
  newId,
  type NewInputRequest,
  newRequestId,
  type Op,
  OpError,
  parseWall,
  type Wall,
  WallParseError,
  type WallSummary,
  type WallWarning,
  type RequestStatus,
} from '@hsw-editor/core';
import { z } from 'zod';
import { appendDurable, atomicWrite, isNotFound } from './fsutil.ts';

export type StoreErrorCode =
  | 'wall_not_found'
  | 'wall_exists'
  | 'invalid_id'
  | 'rev_conflict'
  | 'nothing_to_undo'
  | 'nothing_to_redo'
  | 'undo_conflict'
  | 'redo_conflict'
  | 'asset_not_found'
  | 'corrupt'
  | 'request_not_found'
  | 'request_closed'
  | 'invalid_request'
  | 'locked';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  /** Current wall for `rev_conflict`, so the client can rebase without another round trip. */
  readonly wall: Wall | undefined;

  constructor(code: StoreErrorCode, message: string, wall?: Wall) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.wall = wall;
  }
}

/** Test seams that simulate a crash at the two interesting points of the commit protocol. */
export interface StoreHooks {
  afterHistoryAppend?: () => Promise<void> | void;
  beforeWallRename?: () => Promise<void> | void;
}

export interface StoreOptions {
  home: string;
  now?: () => Date;
  hooks?: StoreHooks;
}

export interface ApplyRequest {
  ops: Op[];
  baseRev?: number | undefined;
  actor: Actor;
  label?: string | undefined;
}

export interface Outcome {
  changed: boolean;
  wall: Wall;
  op: Op;
  inverse: Op;
  warnings: WallWarning[];
  canUndo: boolean;
  canRedo: boolean;
  entry: ChangeEntry | undefined;
}

export interface WallState {
  wall: Wall;
  warnings: WallWarning[];
  canUndo: boolean;
  canRedo: boolean;
}

export type RequestEvent =
  | { type: 'request_input'; request: InputRequest }
  | { type: 'request_resolved'; id: string; status: 'answered' | 'cancelled'; answer?: JsonValue };

export interface WallListener {
  /** Called synchronously, once, before any other callback: what the subscriber missed. */
  onResume(resume: Resume, openRequests: InputRequest[]): void;
  onEntry(entry: ChangeEntry): void;
  onRequest(event: RequestEvent): void;
  onDeleted(): void;
}

export type Resume = { kind: 'snapshot'; wall: Wall } | { kind: 'replay'; entries: ChangeEntry[] };

export interface AssetSlot {
  /** Directory relative to the wall dir: `photos`, `photos/derived` or `models`. */
  dir: 'photos' | 'photos/derived' | 'models';
  ext: string;
  bytes: Uint8Array;
  prefix?: string;
}

const ASSET_DIRS: readonly string[] = ['photos', 'photos/derived', 'models'];
const EXT_PATTERN = /^[a-z0-9]{1,8}$/;

class LoadedWall {
  wall: Wall;
  entries: HistoryEntry[];
  /** Revs of the entries that can be undone / redone, newest last. */
  undoStack: number[];
  redoStack: number[];
  /** Input requests (open and resolved); persisted in requests.json, never part of the history. */
  requests: InputRequest[];
  readonly listeners = new Set<WallListener>();
  /** Wake-ups for long-polling readers of a request, keyed by request id. */
  readonly waiters = new Map<string, Set<() => void>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    state: Pick<LoadedWall, 'wall' | 'entries' | 'undoStack' | 'redoStack'>,
    requests: InputRequest[] = [],
  ) {
    this.wall = state.wall;
    this.entries = state.entries;
    this.undoStack = state.undoStack;
    this.redoStack = state.redoStack;
    this.requests = requests;
  }

  /** Serialises mutations of one wall. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  entryAt(rev: number): HistoryEntry | undefined {
    const first = this.entries[0];
    return first === undefined ? undefined : this.entries[rev - first.rev];
  }

  replaceState(next: LoadedWall): void {
    this.wall = next.wall;
    this.entries = next.entries;
    this.undoStack = next.undoStack;
    this.redoStack = next.redoStack;
  }

  openRequests(): InputRequest[] {
    return this.requests.filter((request) => request.status === 'open');
  }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug === '' ? 'wall' : slug;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export class WallStore {
  readonly home: string;
  private readonly wallsDir: string;
  private readonly now: () => Date;
  private readonly hooks: StoreHooks;
  private readonly loaded = new Map<string, LoadedWall>();
  private readonly loading = new Map<string, Promise<LoadedWall>>();

  constructor(options: StoreOptions) {
    this.home = resolve(options.home);
    this.wallsDir = join(this.home, 'walls');
    this.now = options.now ?? (() => new Date());
    this.hooks = options.hooks ?? {};
  }

  /** Creates the directory layout and takes the single-writer lock. */
  async init(): Promise<void> {
    await mkdir(this.wallsDir, { recursive: true });
    const lockPath = join(this.home, 'server.lock');
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
    } catch {
      const holder = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      if (Number.isInteger(holder) && holder !== process.pid && processAlive(holder)) {
        throw new StoreError('locked', `${this.home} is already served by pid ${holder}`);
      }
      await writeFile(lockPath, `${process.pid}\n`);
    }
  }

  async close(): Promise<void> {
    await rm(join(this.home, 'server.lock'), { force: true });
  }

  wallDir(id: string): string {
    if (!ID_PATTERN.test(id)) throw new StoreError('invalid_id', `invalid wall id ${id}`);
    return join(this.wallsDir, id);
  }

  // ---- reading -------------------------------------------------------------------------------------

  async list(): Promise<WallSummary[]> {
    const names = await readdir(this.wallsDir).catch(() => []);
    const summaries: WallSummary[] = [];
    for (const name of names) {
      if (!ID_PATTERN.test(name)) continue;
      try {
        const loaded = await this.open(name);
        const last = loaded.entries.at(-1);
        summaries.push({
          id: loaded.wall.id,
          name: loaded.wall.name,
          rev: loaded.wall.rev,
          items: loaded.wall.items.length,
          photos: loaded.wall.photos.length,
          models: loaded.wall.models.length,
          updatedAt: last?.ts ?? '',
        });
      } catch (error) {
        console.error(`hsw-editor: skipping wall ${name}: ${String(error)}`);
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<WallState> {
    return this.state(await this.open(id));
  }

  async history(id: string, since: number, limit: number): Promise<HistoryEntry[]> {
    const loaded = await this.open(id);
    return loaded.entries.filter((entry) => entry.rev > since).slice(0, limit);
  }

  async exportWall(id: string): Promise<{ wall: Wall; history: HistoryEntry[] }> {
    const loaded = await this.open(id);
    return { wall: loaded.wall, history: [...loaded.entries] };
  }

  private state(loaded: LoadedWall): WallState {
    return {
      wall: loaded.wall,
      warnings: checkWall(loaded.wall),
      canUndo: loaded.undoStack.length > 0,
      canRedo: loaded.redoStack.length > 0,
    };
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  async create(
    input: { name: string; id?: string | undefined; board?: Board | undefined },
    actor: Actor,
  ): Promise<WallState> {
    const id = input.id ?? `${slugify(input.name)}-${newId('w').slice(2, 8)}`;
    const dir = this.wallDir(id);
    try {
      await mkdir(dir);
    } catch {
      throw new StoreError('wall_exists', `wall ${id} already exists`);
    }
    const wall = createEmptyWall(id, input.name, input.board ?? DEFAULT_BOARD);
    const entry: HistoryEntry = {
      kind: 'create',
      rev: 0,
      ts: this.now().toISOString(),
      actor,
      wall,
    };
    await appendDurable(join(dir, 'history.jsonl'), `${JSON.stringify(entry)}\n`);
    await atomicWrite(join(dir, 'wall.json'), `${JSON.stringify(wall, null, 2)}\n`);
    const loaded = new LoadedWall({ wall, entries: [entry], undoStack: [], redoStack: [] });
    this.loaded.set(id, loaded);
    return this.state(loaded);
  }

  /** Moves the wall to `walls/.trash/`; nothing is ever unlinked. */
  async remove(id: string): Promise<string> {
    const loaded = await this.open(id);
    return loaded.run(async () => {
      const trash = join(this.wallsDir, '.trash');
      await mkdir(trash, { recursive: true });
      const target = join(trash, `${id}-${this.now().toISOString().replace(/[:.]/g, '-')}`);
      await rename(this.wallDir(id), target);
      this.loaded.delete(id);
      for (const listener of loaded.listeners) listener.onDeleted();
      loaded.listeners.clear();
      return target;
    });
  }

  // ---- mutation ------------------------------------------------------------------------------------

  apply(id: string, request: ApplyRequest): Promise<Outcome> {
    return this.mutate(id, request.baseRev, async (loaded) => {
      const op = combine(request.ops, request.label);
      const result = applyOp(loaded.wall, op);
      return this.commit(loaded, {
        kind: 'op',
        actor: request.actor,
        op,
        result,
        label: request.label,
      });
    });
  }

  undo(id: string, request: { baseRev?: number | undefined; actor: Actor }): Promise<Outcome> {
    return this.mutate(id, request.baseRev, async (loaded) => {
      const ref = loaded.undoStack.at(-1);
      const target = ref === undefined ? undefined : loaded.entryAt(ref);
      if (ref === undefined || target === undefined || target.kind === 'create') {
        throw new StoreError('nothing_to_undo', 'nothing to undo');
      }
      const result = reduce(loaded.wall, target.inverse, 'undo_conflict', `cannot undo rev ${ref}`);
      return this.commit(loaded, {
        kind: 'undo',
        actor: request.actor,
        op: target.inverse,
        result,
        ref,
      });
    });
  }

  redo(id: string, request: { baseRev?: number | undefined; actor: Actor }): Promise<Outcome> {
    return this.mutate(id, request.baseRev, async (loaded) => {
      const ref = loaded.redoStack.at(-1);
      const target = ref === undefined ? undefined : loaded.entryAt(ref);
      if (ref === undefined || target === undefined || target.kind === 'create') {
        throw new StoreError('nothing_to_redo', 'nothing to redo');
      }
      const result = reduce(loaded.wall, target.op, 'redo_conflict', `cannot redo rev ${ref}`);
      return this.commit(loaded, {
        kind: 'redo',
        actor: request.actor,
        op: target.op,
        result,
        ref,
      });
    });
  }

  private async mutate(
    id: string,
    baseRev: number | undefined,
    task: (loaded: LoadedWall) => Promise<Outcome>,
  ): Promise<Outcome> {
    const loaded = await this.open(id);
    return loaded.run(async () => {
      if (this.loaded.get(id) !== loaded)
        throw new StoreError('wall_not_found', `wall ${id} was deleted`);
      if (baseRev !== undefined && baseRev !== loaded.wall.rev) {
        throw new StoreError(
          'rev_conflict',
          `wall is at rev ${loaded.wall.rev}, request was based on rev ${baseRev}`,
          loaded.wall,
        );
      }
      return task(loaded);
    });
  }

  private async commit(
    loaded: LoadedWall,
    change: {
      kind: 'op' | 'undo' | 'redo';
      actor: Actor;
      op: Op;
      result: ApplyResult;
      ref?: number;
      label?: string | undefined;
    },
  ): Promise<Outcome> {
    const { result } = change;
    if (!result.changed && change.kind === 'op') {
      return this.outcome(loaded, change.op, result, undefined);
    }
    // undo/redo always consume their stack slot, so a no-op inverse still moves the rev forward
    const wall = result.changed ? result.wall : { ...result.wall, rev: loaded.wall.rev + 1 };
    const entry: ChangeEntry = {
      kind: change.kind,
      rev: wall.rev,
      ts: this.now().toISOString(),
      actor: change.actor,
      op: change.op,
      inverse: result.inverse,
      ...(change.ref === undefined ? {} : { ref: change.ref }),
      ...(change.label === undefined ? {} : { label: change.label }),
    };
    const dir = this.wallDir(wall.id);
    const entriesBefore = loaded.entries.length;
    try {
      await appendDurable(join(dir, 'history.jsonl'), `${JSON.stringify(entry)}\n`);
      await this.hooks.afterHistoryAppend?.();
      await atomicWrite(
        join(dir, 'wall.json'),
        `${JSON.stringify(wall, null, 2)}\n`,
        this.hooks.beforeWallRename,
      );
    } catch (error) {
      // The disk is the truth: rebuild from it (history may already contain the entry) and tell listeners.
      loaded.replaceState(await this.loadFromDisk(wall.id));
      for (const missed of loaded.entries.slice(entriesBefore)) {
        if (missed.kind !== 'create') this.publish(loaded, missed);
      }
      throw error;
    }
    loaded.wall = wall;
    loaded.entries.push(entry);
    advanceStacks(loaded, entry);
    this.publish(loaded, entry);
    return this.outcome(loaded, change.op, { ...result, wall }, entry);
  }

  private outcome(
    loaded: LoadedWall,
    op: Op,
    result: ApplyResult,
    entry: ChangeEntry | undefined,
  ): Outcome {
    return {
      changed: result.changed,
      wall: result.wall,
      op,
      inverse: result.inverse,
      warnings: result.warnings,
      canUndo: loaded.undoStack.length > 0,
      canRedo: loaded.redoStack.length > 0,
      entry,
    };
  }

  private publish(loaded: LoadedWall, entry: ChangeEntry): void {
    for (const listener of loaded.listeners) {
      try {
        listener.onEntry(entry);
      } catch (error) {
        console.error(`hsw-editor: wall listener failed: ${String(error)}`);
      }
    }
  }

  // ---- subscriptions -------------------------------------------------------------------------------

  /**
   * Attaches a live listener. `onResume` runs in the same tick as the registration, so no entry can fall
   * between the replay and the live stream, and none can arrive out of order.
   */
  async subscribe(
    id: string,
    since: number | undefined,
    listener: WallListener,
  ): Promise<() => void> {
    const loaded = await this.open(id);
    const first = loaded.entries[0];
    // a client ahead of us, or behind the retained history, cannot be replayed: resync with a snapshot
    const resume: Resume =
      since === undefined || since > loaded.wall.rev || (first !== undefined && since < first.rev)
        ? { kind: 'snapshot', wall: loaded.wall }
        : {
            kind: 'replay',
            entries: loaded.entries.filter(
              (entry): entry is ChangeEntry => entry.kind !== 'create' && entry.rev > since,
            ),
          };
    listener.onResume(resume, loaded.openRequests());
    loaded.listeners.add(listener);
    return () => loaded.listeners.delete(listener);
  }

  // ---- input requests ------------------------------------------------------------------------------

  /** Opens a question for the human; broadcast to every connected client as `request_input`. */
  async createRequest(id: string, input: NewInputRequest, actor: Actor): Promise<InputRequest> {
    const loaded = await this.open(id);
    return loaded.run(async () => {
      this.assertLive(id, loaded);
      const problem = requestReferenceProblem(loaded.wall, input);
      if (problem !== undefined) throw new StoreError('invalid_request', problem);
      const request: InputRequest = {
        ...input,
        id: newRequestId(),
        status: 'open',
        createdBy: actor,
        createdAt: this.now().toISOString(),
      };
      await this.saveRequests(loaded, [...loaded.requests, request]);
      this.publishRequest(loaded, { type: 'request_input', request });
      return request;
    });
  }

  async listRequests(id: string, status?: RequestStatus): Promise<InputRequest[]> {
    const loaded = await this.open(id);
    return loaded.requests.filter((request) => status === undefined || request.status === status);
  }

  /** The request; while it is open, waits up to `waitMs` for it to be resolved (long poll). */
  async getRequest(
    id: string,
    requestId: string,
    waitMs = 0,
    signal?: AbortSignal,
  ): Promise<InputRequest> {
    const loaded = await this.open(id);
    const request = findRequest(loaded, requestId);
    if (request.status !== 'open' || waitMs <= 0 || signal?.aborted === true) return request;
    await new Promise<void>((resolveWait) => {
      const waiters = loaded.waiters.get(requestId) ?? new Set<() => void>();
      loaded.waiters.set(requestId, waiters);
      const timer = setTimeout(done, waitMs);
      function done(): void {
        clearTimeout(timer);
        waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolveWait();
      }
      waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
    return findRequest(loaded, requestId);
  }

  /** Waits until the request is resolved; aborting the signal cancels the request. */
  async awaitRequest(id: string, requestId: string, signal: AbortSignal): Promise<InputRequest> {
    for (;;) {
      const request = await this.getRequest(id, requestId, 25_000, signal);
      if (request.status !== 'open') return request;
      if (signal.aborted) {
        return this.resolveRequest(id, requestId, 'cancelled', undefined, {
          kind: 'agent',
          name: 'aborted',
        });
      }
    }
  }

  answerRequest(
    id: string,
    requestId: string,
    answer: JsonValue,
    actor: Actor,
  ): Promise<InputRequest> {
    return this.resolveRequest(id, requestId, 'answered', answer, actor);
  }

  cancelRequest(id: string, requestId: string, actor: Actor): Promise<InputRequest> {
    return this.resolveRequest(id, requestId, 'cancelled', undefined, actor);
  }

  private async resolveRequest(
    id: string,
    requestId: string,
    status: 'answered' | 'cancelled',
    answer: JsonValue | undefined,
    actor: Actor,
  ): Promise<InputRequest> {
    const loaded = await this.open(id);
    return loaded.run(async () => {
      this.assertLive(id, loaded);
      const current = findRequest(loaded, requestId);
      if (current.status !== 'open') {
        throw new StoreError('request_closed', `request ${requestId} is already ${current.status}`);
      }
      const resolved: InputRequest = {
        ...current,
        status,
        resolvedBy: actor,
        resolvedAt: this.now().toISOString(),
        ...(answer === undefined ? {} : { answer }),
      };
      await this.saveRequests(
        loaded,
        loaded.requests.map((request) => (request.id === requestId ? resolved : request)),
      );
      this.publishRequest(loaded, {
        type: 'request_resolved',
        id: requestId,
        status,
        ...(answer === undefined ? {} : { answer }),
      });
      for (const wake of [...(loaded.waiters.get(requestId) ?? [])]) wake();
      return resolved;
    });
  }

  /** Persists first, then swaps memory, so a failed write leaves both unchanged. */
  private async saveRequests(loaded: LoadedWall, next: InputRequest[]): Promise<void> {
    const open = next.filter((request) => request.status === 'open');
    const closed = next.filter((request) => request.status !== 'open').slice(-MAX_CLOSED_REQUESTS);
    const kept = next.filter((request) => open.includes(request) || closed.includes(request));
    await atomicWrite(
      join(this.wallDir(loaded.wall.id), 'requests.json'),
      `${JSON.stringify(kept, null, 2)}\n`,
    );
    loaded.requests = kept;
  }

  private publishRequest(loaded: LoadedWall, event: RequestEvent): void {
    for (const listener of loaded.listeners) {
      try {
        listener.onRequest(event);
      } catch (error) {
        console.error(`hsw-editor: wall listener failed: ${String(error)}`);
      }
    }
  }

  private assertLive(id: string, loaded: LoadedWall): void {
    if (this.loaded.get(id) !== loaded)
      throw new StoreError('wall_not_found', `wall ${id} was deleted`);
  }

  // ---- assets --------------------------------------------------------------------------------------

  /** Writes a new asset file atomically and returns its path relative to the wall dir. */
  async addAsset(id: string, slot: AssetSlot): Promise<string> {
    await this.open(id);
    if (!ASSET_DIRS.includes(slot.dir) || !EXT_PATTERN.test(slot.ext)) {
      throw new StoreError('invalid_id', `invalid asset slot ${slot.dir}/.${slot.ext}`);
    }
    const name = `${newId(slot.prefix ?? 'a')}.${slot.ext}`;
    const relative = `${slot.dir}/${name}`;
    await atomicWrite(join(this.wallDir(id), relative), slot.bytes);
    return relative;
  }

  async removeAsset(id: string, relative: string): Promise<void> {
    await rm(this.assetPath(id, relative), { force: true });
  }

  /** Absolute path of an asset, confined to the wall's asset directories. */
  assetPath(id: string, relative: string): string {
    const dir = this.wallDir(id);
    const absolute = resolve(dir, relative);
    const inside = ASSET_DIRS.some(
      (assetDir) => absolute.startsWith(join(dir, assetDir) + sep) && !relative.includes('\0'),
    );
    if (!inside) throw new StoreError('asset_not_found', `no such asset ${relative}`);
    return absolute;
  }

  // ---- loading -------------------------------------------------------------------------------------

  private open(id: string): Promise<LoadedWall> {
    const cached = this.loaded.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    const pending = this.loading.get(id);
    if (pending !== undefined) return pending;
    const load = this.loadFromDisk(id)
      .then((loaded) => {
        this.loaded.set(id, loaded);
        return loaded;
      })
      .finally(() => this.loading.delete(id));
    this.loading.set(id, load);
    return load;
  }

  private async loadFromDisk(id: string): Promise<LoadedWall> {
    const dir = this.wallDir(id);
    if (
      !(await stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    ) {
      throw new StoreError('wall_not_found', `wall ${id} does not exist`);
    }
    const entries = await readHistory(join(dir, 'history.jsonl'));
    const snapshot = await readSnapshot(join(dir, 'wall.json'));
    await this.removeStaleTemps(dir);

    let wall: Wall;
    let recovered = false;
    if (entries.length === 0) {
      if (snapshot === undefined)
        throw new StoreError('corrupt', `wall ${id}: no readable wall.json or history`);
      // A hand-placed or pre-history wall: adopt the snapshot as the history's starting point.
      const create: HistoryEntry = {
        kind: 'create',
        rev: snapshot.rev,
        ts: this.now().toISOString(),
        actor: { kind: 'cli', name: 'recover' },
        wall: snapshot,
      };
      await appendDurable(join(dir, 'history.jsonl'), `${JSON.stringify(create)}\n`);
      entries.push(create);
      wall = snapshot;
    } else {
      const last = entries[entries.length - 1];
      if (last === undefined) throw new StoreError('corrupt', `wall ${id}: empty history`);
      if (snapshot !== undefined && snapshot.rev === last.rev) {
        wall = snapshot;
      } else {
        wall = replay(id, entries, snapshot);
        recovered = true;
      }
    }
    if (recovered) await atomicWrite(join(dir, 'wall.json'), `${JSON.stringify(wall, null, 2)}\n`);
    const requests = await readRequests(join(dir, 'requests.json'));
    const loaded = new LoadedWall({ wall, entries, undoStack: [], redoStack: [] }, requests);
    for (const entry of entries) advanceStacks(loaded, entry);
    return loaded;
  }

  private async removeStaleTemps(dir: string): Promise<void> {
    for (const name of await readdir(dir).catch(() => [])) {
      if (name.startsWith('wall.json.tmp-')) await rm(join(dir, name), { force: true });
    }
  }
}

function combine(ops: Op[], label: string | undefined): Op {
  const [only] = ops;
  if (ops.length === 1 && only !== undefined) return only;
  const leaves = ops.flatMap((op) => (op.type === 'batch' ? op.ops : [op]));
  return { type: 'batch', ops: leaves, ...(label === undefined ? {} : { label }) };
}

function reduce(
  wall: Wall,
  op: Op,
  code: 'undo_conflict' | 'redo_conflict',
  message: string,
): ApplyResult {
  try {
    return applyOp(wall, op);
  } catch (error) {
    if (error instanceof OpError) throw new StoreError(code, `${message}: ${error.message}`);
    throw error;
  }
}

function advanceStacks(loaded: LoadedWall, entry: HistoryEntry): void {
  if (entry.kind === 'op') {
    loaded.undoStack.push(entry.rev);
    loaded.redoStack.length = 0;
  } else if (entry.kind === 'undo') {
    const popped = loaded.undoStack.pop();
    if (popped !== undefined) loaded.redoStack.push(popped);
  } else if (entry.kind === 'redo') {
    loaded.redoStack.pop();
    loaded.undoStack.push(entry.rev);
  }
}

/** Reads valid history lines, drops a torn/garbled tail, and fails on corruption in the middle. */
async function readHistory(path: string): Promise<HistoryEntry[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const entries: HistoryEntry[] = [];
  let validBytes = 0;
  let offset = 0;
  let damaged = false;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) {
      damaged = true; // no trailing newline: torn write
      break;
    }
    const line = bytes.subarray(offset, newline).toString('utf8');
    const parsed = parseEntry(line);
    const previous = entries.at(-1);
    const expectedRev = previous === undefined ? undefined : previous.rev + 1;
    if (parsed === undefined || (expectedRev !== undefined && parsed.rev !== expectedRev)) {
      damaged = true;
      if (bytes.subarray(newline + 1).some((b) => b > 0x20)) {
        throw new StoreError(
          'corrupt',
          `${path}: unreadable entry at byte ${offset} followed by more data`,
        );
      }
      break;
    }
    entries.push(parsed);
    offset = newline + 1;
    validBytes = offset;
  }
  if (damaged) await truncate(path, validBytes);
  return entries;
}

function parseEntry(line: string): HistoryEntry | undefined {
  try {
    const raw: JsonValue = JSON.parse(line);
    const parsed = HistoryEntrySchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

async function readSnapshot(path: string): Promise<Wall | undefined> {
  try {
    const raw: JsonValue = JSON.parse(await readFile(path, 'utf8'));
    return parseWall(raw);
  } catch (error) {
    if (isNotFound(error) || error instanceof SyntaxError || error instanceof WallParseError) {
      return undefined;
    }
    throw error;
  }
}

/** Rebuilds the wall from history, starting at the snapshot when it is not ahead of the history. */
function replay(id: string, entries: HistoryEntry[], snapshot: Wall | undefined): Wall {
  const [first] = entries;
  if (first === undefined || first.kind !== 'create') {
    throw new StoreError('corrupt', `wall ${id}: history does not start with a create entry`);
  }
  const last = entries[entries.length - 1];
  const usable =
    snapshot !== undefined &&
    last !== undefined &&
    snapshot.rev <= last.rev &&
    snapshot.rev >= first.rev;
  let wall = usable ? snapshot : first.wall;
  for (const entry of entries) {
    if (entry.kind === 'create' || entry.rev <= wall.rev) continue;
    try {
      wall = { ...applyOp(wall, entry.op).wall, rev: entry.rev };
    } catch (error) {
      if (error instanceof OpError) {
        throw new StoreError(
          'corrupt',
          `wall ${id}: history entry ${entry.rev} does not replay: ${error.message}`,
        );
      }
      throw error;
    }
  }
  return wall;
}

const MAX_CLOSED_REQUESTS = 300;
const RequestListSchema = z.array(InputRequestSchema);

function findRequest(loaded: LoadedWall, requestId: string): InputRequest {
  const request = loaded.requests.find((candidate) => candidate.id === requestId);
  if (request === undefined) throw new StoreError('request_not_found', `no request ${requestId}`);
  return request;
}

/** A request may only point at things that exist on the wall. */
function requestReferenceProblem(wall: Wall, input: NewInputRequest): string | undefined {
  if (input.itemId !== undefined && !wall.items.some((item) => item.id === input.itemId)) {
    return `itemId ${input.itemId} is not on the wall`;
  }
  const photoIds = [
    input.photoId,
    input.kind === 'calibration' ? input.payload.photoId : undefined,
  ];
  for (const photoId of photoIds) {
    if (photoId !== undefined && !wall.photos.some((photo) => photo.id === photoId)) {
      return `photoId ${photoId} is not on the wall`;
    }
  }
  if (input.kind === 'compare') {
    const missing = input.payload.modelRefIds.find(
      (modelId) => !wall.models.some((model) => model.id === modelId),
    );
    if (missing !== undefined) return `model ${missing} is not on the wall`;
  }
  return undefined;
}

async function readRequests(path: string): Promise<InputRequest[]> {
  try {
    const raw: JsonValue = JSON.parse(await readFile(path, 'utf8'));
    const parsed = RequestListSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    console.error(`hsw-editor: ignoring unreadable ${path}: ${parsed.error.message}`);
  } catch (error) {
    if (!isNotFound(error))
      console.error(`hsw-editor: ignoring unreadable ${path}: ${String(error)}`);
  }
  return [];
}
