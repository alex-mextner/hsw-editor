import { createValueStore } from '#state-backend';
import { WallSchema, type Op, type Wall } from '@hsw-editor/core';
import { z } from 'zod';
import { api, HUMAN } from '@/api/http.ts';
import { HistoryEntrySchema, type WallSummary } from '@/api/schemas.ts';
import { currentWallId } from '@/state/current-wall.ts';
import { patchEditor, setSelection } from '@/state/editor.ts';
import { clearRequests, handleRequestEvent, loadOpenRequests } from '@/widgets/requests.ts';
import { WallSync, type SubmitResult, type SyncState } from './sync.ts';

/** The wall open in the editor; null until one is chosen. */
export const sessionStore = createValueStore<SyncState | null>(null);
export const wallListStore = createValueStore<{
  readonly status: 'loading' | 'ready' | 'error';
  readonly walls: readonly WallSummary[];
}>({ status: 'loading', walls: [] });

let sync: WallSync | null = null;
let source: EventSource | null = null;
let detach: (() => void) | null = null;

const SnapshotSchema = z.object({ wall: WallSchema });
const HeartbeatSchema = z.object({ rev: z.number().int() });

function connectEvents(target: WallSync): EventSource {
  const events = new EventSource(api.eventsUrl(target.wallId));
  const read = <T>(schema: z.ZodType<T>, raw: Event): T | null => {
    if (!(raw instanceof MessageEvent) || typeof raw.data !== 'string') return null;
    let json: unknown;
    try {
      json = JSON.parse(raw.data);
    } catch {
      return null;
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? parsed.data : null;
  };
  events.addEventListener('snapshot', (raw) => {
    const data = read(SnapshotSchema, raw);
    if (data) target.applySnapshot(data.wall);
  });
  events.addEventListener('op', (raw) => {
    const entry = read(HistoryEntrySchema, raw);
    if (entry && entry.kind !== 'create') void target.applyRemote(entry);
  });
  events.addEventListener('heartbeat', (raw) => {
    const beat = read(HeartbeatSchema, raw);
    if (beat && beat.rev > target.getSnapshot().confirmedRev) void target.resync();
  });
  events.addEventListener('deleted', () => target.markDeleted());
  // Server-raised widget requests (agents, vision); also reloaded after a reconnect so none is missed.
  events.addEventListener('request_input', (raw) => {
    if (raw instanceof MessageEvent) handleRequestEvent('request_input', raw.data);
  });
  events.addEventListener('request_resolved', (raw) => {
    if (raw instanceof MessageEvent) handleRequestEvent('request_resolved', raw.data);
  });
  events.addEventListener('open', () => void loadOpenRequests(target.wallId));
  return events;
}

/** Opens `wallId`: loads it, subscribes to live events, mirrors the sync state into `sessionStore`. */
export function openWall(wallId: string): void {
  closeWall();
  const next = new WallSync(wallId, api, HUMAN);
  sync = next;
  detach = next.subscribe(() => sessionStore.set(next.getSnapshot()));
  sessionStore.set(next.getSnapshot());
  source = connectEvents(next);
  void next.load();
}

export function closeWall(): void {
  source?.close();
  detach?.();
  sync?.dispose();
  source = null;
  detach = null;
  sync = null;
  patchEditor({ placeAt: null });
  sessionStore.set(null);
  clearRequests();
  setSelection([]);
}

export function submitOps(ops: readonly Op[], label?: string): SubmitResult {
  if (!sync) throw new Error('no wall is open');
  return sync.submit(ops, label);
}

export function undoEdit(): void {
  sync?.undo();
}

export function redoEdit(): void {
  sync?.redo();
}

export async function refreshWalls(): Promise<void> {
  try {
    wallListStore.set({ status: 'ready', walls: await api.listWalls() });
  } catch {
    wallListStore.set({ status: 'error', walls: wallListStore.get().walls });
  }
}

/** Creates a wall on the server and opens it. */
export async function createAndOpenWall(name: string, board?: Wall['board']): Promise<Wall> {
  const wall = await api.createWall({ name, ...(board ? { board } : {}) });
  currentWallId.set(wall.id);
  await refreshWalls();
  return wall;
}

/** Keeps the open wall in step with the persisted "current wall" pointer (a reload reopens it). */
export function initSession(): void {
  currentWallId.subscribe(() => {
    const id = currentWallId.get();
    if (id === null) closeWall();
    else if (sync?.wallId !== id) openWall(id);
  });
  const initial = currentWallId.get();
  if (initial !== null) openWall(initial);
  void refreshWalls();
}
