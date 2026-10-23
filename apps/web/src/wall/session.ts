import { createValueStore } from '#state-backend';
import { WallSchema, type Op, type Wall } from '@hsw-editor/core';
import { z } from 'zod';
import { api, HUMAN } from '@/api/http.ts';
import { HistoryEntrySchema, type WallSummary } from '@/api/schemas.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { patchEditor, setSelection } from '@/state/editor.ts';
import { leavePhotoMode } from '@/state/photo.ts';
import { clearRequests, handleRequestEvent, loadOpenRequests } from '@/widgets/requests.ts';
import { DEMO } from '@/demo/mode.ts';
import { DEMO_WALL_ID, demoApi } from '@/demo/demoApi.ts';
import { createLiveSource, type LiveLink } from '@/offline/live.ts';
import { connection, wallMirror } from '@/offline/runtime.ts';
import type { Strategy } from '@/offline/reconcile.ts';
import { WallSync, type SubmitResult, type SyncState } from './sync.ts';

/** The wall open in the editor; null until one is chosen. */
export const sessionStore = createValueStore<SyncState | null>(null);
export const wallListStore = createValueStore<{
  readonly status: 'loading' | 'ready' | 'error';
  readonly walls: readonly WallSummary[];
}>({ status: 'loading', walls: [] });

let sync: WallSync | null = null;
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

/** Opens `wallId`: loads it, subscribes to live events, mirrors the sync state into `sessionStore`. */
export function openWall(wallId: string): void {
  closeWall();
  // The demo wall is bundled: nothing to mirror, nothing to replay.
  const next = new WallSync(
    wallId,
    DEMO ? demoApi : api,
    HUMAN,
    Date.now,
    DEMO
      ? null
      : {
          load: (id) => wallMirror.get(id),
          save: (record) => void wallMirror.put(record).catch(() => undefined),
        },
  );
  sync = next;
  detach = next.subscribe(() => sessionStore.set(next.getSnapshot()));
  sessionStore.set(next.getSnapshot());
  // The demo has no daemon: no event stream either.
  link = DEMO ? null : connectEvents(next);
  void next.load();
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
  return sync.submit(ops, label);
}

/** Shows the wall an upload answered with (the photo is in it) without waiting for the live event; false when another wall is open now. */
export function applyUploadedWall(wall: Wall): boolean {
  if (sync?.wallId !== wall.id) return false;
  sync.acceptUploaded(wall);
  return true;
}

export function undoEdit(): void {
  sync?.undo();
}

export function redoEdit(): void {
  sync?.redo();
}

/** The user's answer to the conflict dialog (`SyncState.conflict`). */
export function resolveConflict(strategy: Strategy): void {
  sync?.resolveConflict(strategy);
}

export async function refreshWalls(): Promise<void> {
  try {
    wallListStore.set({ status: 'ready', walls: await (DEMO ? demoApi : api).listWalls() });
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

/** Creates a wall on the server and opens it. */
export async function createAndOpenWall(name: string, board?: Wall['board']): Promise<Wall> {
  const wall = await (DEMO ? demoApi : api).createWall({ name, ...(board ? { board } : {}) });
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
