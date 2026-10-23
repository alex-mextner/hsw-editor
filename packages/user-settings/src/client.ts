/**
 * Offline-first settings client. Reads come synchronously from a localStorage-shaped mirror; writes land in the mirror
 * at once, are recorded as a pending namespace patch and pushed to the server (debounced, coalesced, one request in
 * flight). On (re)connect the server document is fetched: namespaces with pending local edits keep the local value and
 * are pushed with `baseRev`, every other namespace adopts the server value, so stale data never clobbers an edit.
 * Works with no transport at all (pure local store). One client owns the mirror key: run a single instance per origin
 * (two live clients overwrite each other's pending edits in storage).
 */
import type { JsonValue } from '@hsw-editor/core';
import { z } from 'zod';
import {
  isJsonWithinDepth,
  jsonEqual,
  isValidNamespace,
  NamespaceSchema,
  SETTINGS_SCHEMA_VERSION,
  SettingsContractError,
  type SettingsDocument,
  SettingsValueSchema,
  type SettingsValue,
} from './contract.ts';
import { type PutResult, SettingsRejectedError, type SettingsTransport } from './transport.ts';

export const SETTINGS_MIRROR_KEY = 'hsw-editor:user-settings:v1';
const DEFAULT_DEBOUNCE_MS = 400;

/** The subset of `Storage` the client needs; `window.localStorage` satisfies it. */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `local`: no transport. `unsynced`: transport present, no server contact yet and nothing pending. `synced`: server and mirror agree. `pending`: edits not pushed yet (or never reached the
 * server). `offline`: the last attempt failed. `conflict`: two 409s in a row. `rejected`: the server refused the patch.
 */
export type SyncStatus =
  | 'local'
  | 'unsynced'
  | 'synced'
  | 'pending'
  | 'offline'
  | 'conflict'
  | 'rejected';

export interface SettingsClientOptions {
  transport?: SettingsTransport;
  storage?: SettingsStorage;
  now?: () => Date;
  /** Called after every change of any namespace's effective value (local edit or adopted server value). */
  onChange?: (namespaces: readonly string[]) => void;
  /** Called when a push is permanently refused; the refused patch is dropped and the server value adopted. */
  onRejected?: (error: SettingsRejectedError) => void;
  debounceMs?: number;
}

export interface SettingsClient {
  /** Current effective value of a namespace (pending edit over mirrored server value), `undefined` when absent. */
  get(namespace: string): JsonValue | undefined;
  /** Replaces a namespace. `null` is not a value here (it means delete on the wire): use `remove`. */
  set(namespace: string, value: SettingsValue): void;
  remove(namespace: string): void;
  /** Listener runs only when this namespace's effective value changes. Returns the unsubscribe function. */
  subscribe(namespace: string, listener: (value: JsonValue | undefined) => void): () => void;
  /** Fetch the server document, reconcile, push pending edits. Never rejects; resolves with the resulting status. */
  sync(): Promise<SyncStatus>;
  /** Server told us (SSE) that it is at `rev`: reconcile only if we are behind. */
  notifyServerRev(rev: number): Promise<SyncStatus>;
  status(): SyncStatus;
  /** Last server `rev` this client has seen, `null` before the first successful contact. */
  serverRev(): number | null;
  /** ISO time (from the injected clock) of the last fully reconciled cycle, `null` if none yet. */
  lastSyncedAt(): string | null;
  pendingNamespaces(): readonly string[];
  /** Pushes pending edits now instead of waiting for the debounce. */
  flush(): Promise<SyncStatus>;
  dispose(): void;
}

const MirrorSchema = z.object({
  schema: z.literal(SETTINGS_SCHEMA_VERSION),
  serverRev: z.number().int().nonnegative().nullable(),
  server: z.record(NamespaceSchema, SettingsValueSchema),
  pending: z.record(NamespaceSchema, SettingsValueSchema.nullable()),
});
type Mirror = z.infer<typeof MirrorSchema>;

function emptyMirror(): Mirror {
  return { schema: SETTINGS_SCHEMA_VERSION, serverRev: null, server: {}, pending: {} };
}

function loadMirror(storage: SettingsStorage | undefined): Mirror {
  if (storage === undefined) return emptyMirror();
  try {
    const text = storage.getItem(SETTINGS_MIRROR_KEY);
    if (text === null) return emptyMirror();
    const parsed = MirrorSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : emptyMirror();
  } catch {
    return emptyMirror();
  }
}

function assertNamespace(namespace: string): void {
  if (!isValidNamespace(namespace)) {
    throw new SettingsContractError('invalid_body', `invalid settings namespace "${namespace}"`);
  }
}

interface QueuedCycle {
  promise: Promise<SyncStatus>;
  forceFetch: boolean;
  started: boolean;
}

type Patch = Record<string, JsonValue | null>;

export function createSettingsClient(options: SettingsClientOptions = {}): SettingsClient {
  const { transport, storage, onChange, onRejected } = options;
  const now = options.now ?? (() => new Date());
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const mirror = loadMirror(storage);
  const listeners = new Map<string, Set<(value: JsonValue | undefined) => void>>();
  let currentStatus: SyncStatus = initialStatus();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let queued: QueuedCycle | null = null;
  let disposed = false;
  let syncedAt: string | null = null;
  /** The patch of the PUT currently on the wire: edits to these namespaces must not be pruned against stale server data. */
  let inFlight: Patch | null = null;
  /** Highest server rev announced (SSE) while a PUT was in flight; re-checked once the cycle ends. */
  let announcedRev: number | null = null;

  function pendingCount(): number {
    return Object.keys(mirror.pending).length;
  }

  function initialStatus(): SyncStatus {
    if (transport === undefined) return 'local';
    return pendingCount() > 0 ? 'pending' : 'unsynced';
  }

  function effective(namespace: string): JsonValue | undefined {
    if (Object.hasOwn(mirror.pending, namespace)) return mirror.pending[namespace] ?? undefined;
    return Object.hasOwn(mirror.server, namespace) ? mirror.server[namespace] : undefined;
  }

  function persist(): void {
    if (storage === undefined || disposed) return;
    try {
      storage.setItem(SETTINGS_MIRROR_KEY, JSON.stringify(mirror));
    } catch {
      // quota or privacy mode: the in-memory state stays authoritative for this session
    }
  }

  /** A throwing subscriber must not break sync or the other subscribers. */
  function guarded(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error('hsw-editor: settings listener threw', error);
    }
  }

  function namespaces(): Set<string> {
    return new Set([...Object.keys(mirror.server), ...Object.keys(mirror.pending)]);
  }

  /** Runs `mutate`, then persists and notifies every namespace whose effective value changed. */
  function commit(mutate: () => void): void {
    const names = namespaces();
    const before = new Map([...names].map((name) => [name, effective(name)]));
    mutate();
    for (const name of namespaces()) names.add(name);
    const changed = [...names].filter((name) => !jsonEqual(before.get(name), effective(name)));
    persist();
    for (const name of changed) {
      const value = effective(name);
      for (const listener of [...(listeners.get(name) ?? [])]) guarded(() => listener(value));
    }
    if (changed.length > 0) guarded(() => onChange?.(changed));
  }

  function adopt(document: SettingsDocument): void {
    commit(() => {
      mirror.serverRev = document.rev;
      mirror.server = { ...document.data };
    });
  }

  /**
   * Drops pending edits that equal the freshly fetched server value (a no-op push). Only safe right after a fetch:
   * at write time the mirrored server value may be stale, and dropping against it would lose the user's choice.
   */
  function dropRedundantPending(): void {
    commit(() => {
      for (const name of Object.keys(mirror.pending)) {
        const serverValue = Object.hasOwn(mirror.server, name) ? mirror.server[name] : undefined;
        if (jsonEqual(mirror.pending[name] ?? undefined, serverValue)) delete mirror.pending[name];
      }
    });
  }

  /** Drops pending entries the server now holds (an edit made after `sent` differs and stays). */
  function settle(sent: Patch): void {
    for (const name of Object.keys(sent)) {
      if (Object.hasOwn(mirror.pending, name) && jsonEqual(mirror.pending[name], sent[name])) {
        delete mirror.pending[name];
      }
    }
  }

  function schedulePush(): void {
    if (transport === undefined || disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void enqueue(false);
    }, debounceMs);
  }

  function cancelTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  /** Coalesces cycles: at most one running plus one waiting; a waiting cycle is upgraded to a full fetch on demand. */
  function enqueue(forceFetch: boolean): Promise<SyncStatus> {
    if (disposed) return Promise.resolve(currentStatus);
    if (queued !== null && !queued.started) {
      queued.forceFetch ||= forceFetch;
      return queued.promise;
    }
    const entry: QueuedCycle = {
      promise: Promise.resolve(currentStatus),
      forceFetch,
      started: false,
    };
    entry.promise = queue.then(() => {
      entry.started = true;
      if (queued === entry) queued = null;
      return runCycle(entry.forceFetch);
    });
    queue = entry.promise.catch(() => undefined);
    queued = entry;
    return entry.promise;
  }

  async function runCycle(forceFetch: boolean): Promise<SyncStatus> {
    if (transport === undefined) return 'local';
    if (forceFetch || mirror.serverRev === null) {
      try {
        adopt(await transport.get());
        announcedRev = null; // this fetch already covers anything announced before it
        dropRedundantPending();
      } catch {
        return finish('offline');
      }
    }
    let conflicts = 0;
    // After a refusal the remaining namespaces go one by one so a single bad one cannot drop the good ones.
    let oneByOne = false;
    for (;;) {
      const names = Object.keys(mirror.pending);
      const first = names[0];
      if (first === undefined) return finish('synced');
      const sent: Patch = {};
      for (const name of oneByOne ? [first] : names) sent[name] = mirror.pending[name] ?? null;
      let result: PutResult;
      inFlight = sent;
      try {
        result = await transport.put({
          ...(mirror.serverRev === null ? {} : { baseRev: mirror.serverRev }),
          data: sent,
        });
      } catch (error) {
        inFlight = null;
        if (!(error instanceof SettingsRejectedError)) return finish('offline');
        if (!oneByOne && names.length > 1) {
          oneByOne = true;
          continue;
        }
        commit(() => settle(sent));
        guarded(() => onRejected?.(error));
        if (pendingCount() === 0) return finish('rejected');
        continue;
      }
      inFlight = null;
      if (result.kind === 'conflict') {
        adopt(result.document);
        dropRedundantPending();
        conflicts += 1;
        if (conflicts > 1) return finish('conflict');
        continue;
      }
      // Edits made while the request was in flight stay pending; the pushed ones are now the server's.
      commit(() => {
        mirror.serverRev = result.document.rev;
        mirror.server = { ...result.document.data };
        settle(sent);
      });
    }
  }

  function finish(status: SyncStatus): SyncStatus {
    currentStatus = status === 'synced' && pendingCount() > 0 ? 'pending' : status;
    if (currentStatus === 'synced') syncedAt = now().toISOString();
    // An SSE rev parked during a PUT is acted on once (refetch) unless the PUT's answer or a later fetch already
    // covered it; while offline it stays parked, and after a conflict the conflict's own document was just adopted.
    if (announcedRev === mirror.serverRev) announcedRev = null;
    if (announcedRev !== null && (status === 'synced' || status === 'rejected')) {
      announcedRev = null;
      void enqueue(true);
    }
    return currentStatus;
  }

  function write(namespace: string, value: JsonValue | null): void {
    assertNamespace(namespace);
    if (value !== null && !isJsonWithinDepth(value)) {
      throw new SettingsContractError(
        'invalid_body',
        `value of "${namespace}" is not JSON within the depth limit`,
      );
    }
    commit(() => {
      mirror.pending[namespace] = value;
    });
    if (transport !== undefined) {
      if (pendingCount() > 0) currentStatus = 'pending';
      schedulePush();
    }
  }

  return {
    get: effective,
    set: (namespace, value) => write(namespace, value),
    remove: (namespace) => write(namespace, null),
    subscribe(namespace, listener) {
      const set = listeners.get(namespace) ?? new Set();
      set.add(listener);
      listeners.set(namespace, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(namespace);
      };
    },
    sync() {
      cancelTimer();
      return enqueue(true);
    },
    notifyServerRev(rev) {
      // The answer to a PUT in flight already carries the latest document; finish() settles the announcement.
      if (inFlight !== null) {
        announcedRev = rev;
        return queue.then(() => currentStatus);
      }
      // `!==`, not `>`: a reset or restored settings.json legitimately moves the server's rev backwards.
      const behind = mirror.serverRev !== rev;
      if (behind || pendingCount() > 0 || currentStatus !== 'synced') return enqueue(true);
      return Promise.resolve(currentStatus);
    },
    status: () => currentStatus,
    serverRev: () => mirror.serverRev,
    lastSyncedAt: () => syncedAt,
    pendingNamespaces: () => Object.keys(mirror.pending),
    flush() {
      cancelTimer();
      return enqueue(false);
    },
    dispose() {
      disposed = true;
      cancelTimer();
      listeners.clear();
    },
  };
}
