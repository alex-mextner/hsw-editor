import { createValueStore } from '#state-backend';
import { newId, WallSchema, type Op, type Wall } from '@hsw-editor/core';
import { z } from 'zod';
import { api, HUMAN } from '@/api/http.ts';
import { t } from '@/i18n/index.ts';
import {
  HistoryEntrySchema,
  type ChangeEntry,
  type HistoryEntry,
  type WallSummary,
} from '@/api/schemas.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { createPersistedStore } from '@/state/persisted.ts';
import { patchEditor, setSelection } from '@/state/editor.ts';
import { leavePhotoMode } from '@/state/photo.ts';
import { clearRequests, handleRequestEvent, loadOpenRequests } from '@/widgets/requests.ts';
import { DEMO } from '@/demo/mode.ts';
import { DEMO_WALL_ID, demoApi } from '@/demo/demoApi.ts';
import { createLiveSource, type LiveLink } from '@/offline/live.ts';
import { connection, wallMirror } from '@/offline/runtime.ts';
import type { Strategy } from '@/offline/reconcile.ts';
import { cloneOf, copyName, forkApi, type ForkApi, type WallBackend } from './fork.ts';
import {
  WallSync,
  type OfflineStore,
  type SubmitResult,
  type SyncApi,
  type SyncState,
} from './sync.ts';

/** The wall open in the editor; null until one is chosen. */
export const sessionStore = createValueStore<SyncState | null>(null);
export const wallListStore = createValueStore<{
  readonly status: 'loading' | 'ready' | 'error';
  readonly walls: readonly WallSummary[];
}>({ status: 'loading', walls: [] });

let sync: WallSync | null = null;
/** The copy being made by the first edit of a template, until it exists on the service. */
let pendingFork: { readonly wallId: string; readonly ready: () => Promise<void> } | null = null;
const UnconfirmedCopySchema = z.strictObject({ sourceId: z.string(), name: z.string() });
type UnconfirmedCopy = z.infer<typeof UnconfirmedCopySchema>;
/**
 * Copies whose creation on the service is not confirmed yet, kept across reloads: reopening such a copy makes it then, and without
 * this a copy whose first request failed (offline, closed tab) would come back as a deleted wall. One storage entry per copy, so tabs
 * never overwrite each other's entries.
 */
const unconfirmedKey = (copyId: string): string => `hsw.unconfirmedCopy.${copyId}`;
function unconfirmedCopy(copyId: string): UnconfirmedCopy | null {
  try {
    const raw = globalThis.localStorage?.getItem(unconfirmedKey(copyId));
    if (raw == null) return null;
    const parsed = UnconfirmedCopySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function rememberUnconfirmed(copyId: string, copy: UnconfirmedCopy): void {
  try {
    globalThis.localStorage?.setItem(unconfirmedKey(copyId), JSON.stringify(copy));
  } catch {
    // Storage unavailable: the copy is still made now; only a reload before it exists loses it.
  }
}
function forgetUnconfirmed(copyId: string): void {
  try {
    globalThis.localStorage?.removeItem(unconfirmedKey(copyId));
  } catch {
    // Nothing was stored.
  }
}
let link: LiveLink | null = null;
let detach: (() => void) | null = null;

const SnapshotSchema = z.object({ wall: WallSchema });
const HeartbeatSchema = z.object({ rev: z.number().int() });
const WALL_EVENTS = ['snapshot', 'op', 'heartbeat', 'deleted', 'request_input', 'request_resolved'];

function parseEvent<T>(schema: z.ZodType<T>, data: string): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Live events of the open wall: resumes with `?since=<rev>` after a daemon restart, feeds the connection monitor. */
function connectEvents(target: WallSync): LiveLink {
  const url = api.eventsUrl(target.wallId);
  const live = createLiveSource(
    {
      url: (since) => (since === null ? url : `${url}?since=${since}`),
      create: (eventsUrl) => new EventSource(eventsUrl),
      events: WALL_EVENTS,
      onEvent: (name, data) => {
        if (name === 'snapshot') {
          const snapshot = parseEvent(SnapshotSchema, data);
          if (snapshot) target.applySnapshot(snapshot.wall);
        } else if (name === 'op') {
          const entry = parseEvent(HistoryEntrySchema, data);
          if (entry && entry.kind !== 'create') void target.applyRemote(entry);
        } else if (name === 'heartbeat') {
          const beat = parseEvent(HeartbeatSchema, data);
          if (beat && beat.rev > target.getSnapshot().confirmedRev) void target.resync();
        } else if (name === 'deleted') {
          target.markDeleted();
        } else if (name === 'request_input' || name === 'request_resolved') {
          handleRequestEvent(name, data);
        }
      },
      // Server-raised widget requests are reloaded after every (re)connect so none is missed; a reconnect also
      // refetches the wall, which sends the queued edits.
      onOpen: (resumed) => {
        void loadOpenRequests(target.wallId);
        if (resumed) void target.resync();
      },
    },
    connection,
  );
  live.source.start();
  return live;
}

/** The wall service: the daemon, or the demo build's local walls. */
const backend = (): WallBackend => (DEMO ? demoApi : api);

/** Where the open wall's offline copy goes. The demo has none: its walls are already local and kept by `LocalWalls`. */
const mirrorStore: OfflineStore = {
  load: (id) => wallMirror.get(id),
  save: (record) => void wallMirror.put(record).catch(() => undefined),
};
const offlineStoreFor = (): OfflineStore | null => (DEMO ? null : mirrorStore);

/**
 * Template walls seen so far (`WallResponse.template`): the first edit of one clones it (`fork.ts`). Kept on the device, so a template
 * opened from the offline mirror (the daemon is down at start-up) is still known as one.
 */
const templates = createPersistedStore<readonly string[]>('hsw.templateWalls', [], (raw) => {
  const parsed = z.array(z.string()).safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
});
/** Known from a wall read, or from the wall list (which can answer before the wall itself, e.g. when a live event arrives first). */
const isTemplate = (id: string): boolean =>
  templates.get().includes(id) ||
  wallListStore.get().walls.some((wall) => wall.id === id && wall.template === true);
/** Whether `id` is a template wall: nothing may change it without making a copy first. */
export const isTemplateWall = isTemplate;
/** The copy `id` is still being made on the service. */
export const isCopyPending = (id: string): boolean => pendingFork?.wallId === id;

function noteTemplates(source: SyncApi): SyncApi {
  const note = (id: string, template: boolean): void => {
    const known = templates.get().includes(id);
    if (template && !known) templates.set([...templates.get(), id]);
    else if (!template && known) templates.set(templates.get().filter((other) => other !== id));
  };
  return {
    ...source,
    async getWall(id) {
      const response = await source.getWall(id);
      note(id, response.template === true);
      // A template is never edited, so there is nothing of it to undo or redo.
      return response.template === true
        ? { ...response, canUndo: false, canRedo: false }
        : response;
    },
  };
}

function startLink(target: WallSync): void {
  // The demo has no daemon: no event stream either.
  link = DEMO ? null : connectEvents(target);
}

/** Opens `wallId`: loads it, subscribes to live events, mirrors the sync state into `sessionStore`. */
export function openWall(wallId: string): void {
  closeWall();
  const unconfirmed = unconfirmedCopy(wallId);
  const fork =
    unconfirmed === null
      ? null
      : confirmCopy(wallId, unconfirmed.sourceId, unconfirmed.name, () => null);
  const next = new WallSync(
    wallId,
    noteTemplates(fork ?? backend()),
    HUMAN,
    Date.now,
    offlineStoreFor(),
  );
  adopt(next);
  if (fork) pendingFork = { wallId, ready: fork.ready };
  // The event stream starts once the wall is loaded: a snapshot before that would show the wall as editable before it is known to be
  // a template, and would write an empty queue over the saved edits of a reopened copy.
  void next.load().then(() => {
    if (sync === next && link === null) startLink(next);
  });
}

/** The backend of a copy the service may not have yet: makes it on first use, then forgets it was unconfirmed. */
function confirmCopy(
  copyId: string,
  sourceId: string,
  name: string,
  /** The session whose event stream starts once the copy exists; null when `openWall` starts it after loading. */
  owner: () => WallSync | null,
): ForkApi {
  return forkApi(backend(), sourceId, { id: copyId, name }, () => {
    forgetUnconfirmed(copyId);
    if (pendingFork?.wallId === copyId) pendingFork = null;
    // Only the session that asked for this copy: a reopened one starts its own stream after it has restored its saved edits.
    const target = owner();
    if (target !== null && sync === target && link === null) startLink(target);
  });
}

/** Makes `next` the open wall: mirrors its sync state into `sessionStore`. */
function adopt(next: WallSync): void {
  sync = next;
  detach = next.subscribe(() => sessionStore.set(shown(next)));
  sessionStore.set(shown(next));
}

/** What the editor shows of `target`: a template offers no undo or redo, whatever a live event says (it is never undone here). */
function shown(target: WallSync): SyncState {
  const state = target.getSnapshot();
  return isTemplate(target.wallId) && (state.canUndo || state.canRedo)
    ? { ...state, canUndo: false, canRedo: false }
    : state;
}

/**
 * The open wall is a template (a demo or showcase wall): it is cloned on the first edit. The copy is built from the template that is
 * already on screen, opened as the current wall (same items, same selection) and given the edit by the caller; the service makes its
 * own copy behind it (`forkApi`). Nothing is shown to the user. Returns the sync of the copy, or null when `source` is no template.
 */
function forkTemplate(source: WallSync): WallSync | null {
  const wall = source.getSnapshot().wall;
  if (!wall || !isTemplate(source.wallId)) return null;
  const clone = {
    id: newId('w'),
    name: copyName(wall.name, (name) => t('wall.copyName', { name })),
  };
  rememberUnconfirmed(clone.id, { sourceId: source.wallId, name: clone.name });
  // The daemon's event stream of the copy can only start once the copy exists there.
  let next: WallSync | null = null;
  const fork = confirmCopy(clone.id, source.wallId, clone.name, () => next);
  link?.dispose();
  link = null;
  detach?.();
  source.dispose();
  next = new WallSync(clone.id, noteTemplates(fork), HUMAN, Date.now, offlineStoreFor());
  pendingFork = { wallId: clone.id, ready: fork.ready };
  adopt(next);
  // Nothing is applied to the copy yet, so there is nothing to undo on it.
  next.acceptUploaded(cloneOf(wall, clone.id, clone.name), false);
  // `openWall` is a no-op for this id now: the open sync already is the copy.
  currentWallId.set(clone.id);
  void refreshWalls();
  return next;
}

export function closeWall(): void {
  link?.dispose();
  detach?.();
  sync?.dispose();
  link = null;
  detach = null;
  sync = null;
  patchEditor({ placeAt: null });
  leavePhotoMode();
  sessionStore.set(null);
  clearRequests();
  setSelection([]);
}

export function submitOps(ops: readonly Op[], label?: string): SubmitResult {
  if (!sync) throw new Error('no wall is open');
  if (!isTemplate(sync.wallId)) return sync.submit(ops, label);
  // Only an edit that changes the template makes a copy: a refused or empty one stays on the template, like on any wall.
  const checked = sync.check(ops, label);
  if (!checked.ok) return checked;
  if (!checked.changed) return { ok: true };
  return (forkTemplate(sync) ?? sync).submit(ops, label);
}

/**
 * The id of the wall an edit that goes to the service directly (a photo upload) must target: the open wall, or, when that is a template,
 * its copy (made now, and waited for). Null when no wall is open.
 */
export async function editableWallId(): Promise<string | null> {
  if (!sync) return sessionStore.get()?.wallId ?? null;
  // Not loaded yet: whether it is a template is not known, and an upload must not go into one.
  if (sync.getSnapshot().wall === null) return null;
  const target = forkTemplate(sync) ?? sync;
  if (pendingFork?.wallId === target.wallId) await pendingFork.ready();
  return target.wallId;
}

/** Shows the wall an upload answered with (the photo is in it) without waiting for the live event; false when another wall is open now. */
export function applyUploadedWall(wall: Wall): boolean {
  if (sync?.wallId !== wall.id) return false;
  sync.acceptUploaded(wall);
  return true;
}

/** Undo and redo never touch a template (the first edit leaves it for a copy; its own history is not the visitor's). */
export function undoEdit(): void {
  if (sync && !isTemplate(sync.wallId)) sync.undo();
}

export function redoEdit(): void {
  if (sync && !isTemplate(sync.wallId)) sync.redo();
}

/** The user's answer to the conflict dialog (`SyncState.conflict`). */
export function resolveConflict(strategy: Strategy): void {
  sync?.resolveConflict(strategy);
}

export async function refreshWalls(): Promise<void> {
  try {
    wallListStore.set({ status: 'ready', walls: await backend().listWalls() });
  } catch {
    // Daemon unreachable: list the walls this device has mirrored (with their queued edits).
    const mirrored = await wallMirror.list().catch(() => []);
    wallListStore.set(
      mirrored.length > 0
        ? { status: 'ready', walls: mirrored.map((row) => row.summary) }
        : { status: 'error', walls: wallListStore.get().walls },
    );
  }
}

/** The latest history entries of a wall: the daemon's, or the demo's local ones. */
export function historyEntries(id: string, since: number, limit: number): Promise<HistoryEntry[]> {
  return backend().history(id, since, limit);
}

/** The latest changes of a wall, without its `create` entry. */
export async function wallHistory(
  id: string,
  since: number,
  limit: number,
): Promise<ChangeEntry[]> {
  const entries = await historyEntries(id, since, limit);
  return entries.filter((entry): entry is ChangeEntry => entry.kind !== 'create');
}

/** Deletes a wall (the daemon moves it to its trash; the demo forgets it). */
export function deleteWall(id: string): Promise<void> {
  return backend().deleteWall(id);
}

/** Creates a wall on the server and opens it. */
export async function createAndOpenWall(name: string, board?: Wall['board']): Promise<Wall> {
  const wall = await backend().createWall({ name, ...(board ? { board } : {}) });
  currentWallId.set(wall.id);
  await refreshWalls();
  return wall;
}

/** Keeps the open wall in step with the persisted "current wall" pointer (a reload reopens it). */
export function initSession(): void {
  // The daemon is back: refetch the open wall, which sends the queued edits (and reconciles them).
  connection.onReconnect(() => void sync?.resync());
  currentWallId.subscribe(() => {
    const id = currentWallId.get();
    if (id === null) closeWall();
    else if (sync?.wallId !== id) openWall(id);
  });
  // First visit to the demo lands on its one bundled wall instead of an empty home screen.
  if (DEMO && currentWallId.get() === null) currentWallId.set(DEMO_WALL_ID);
  const initial = currentWallId.get();
  if (initial !== null) openWall(initial);
  void refreshWalls();
}
