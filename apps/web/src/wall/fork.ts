/**
 * Clone on the first edit. A template wall (a demo or showcase wall, `WallResponse.template`) is meant to be copied, not edited in
 * place: the first edit of it makes an independent copy, opens that and applies the edit there, with nothing shown to the user.
 *
 * The copy is made in two halves so the edit can be applied at once: `cloneOf` builds the wall the editor shows from the template
 * that is already loaded, and `forkApi` is the backend of that wall, which creates the copy on the first call that needs it (the
 * daemon's `POST /api/walls/:id/clone`, or the demo's local store) and then behaves like any wall's backend.
 */
import type { Board, Wall, WallSummary } from '@hsw-editor/core';
import { ApiError } from '@/api/http.ts';
import type { HistoryEntry } from '@/api/schemas.ts';
import type { SyncApi } from './sync.ts';

/** The wall service the app talks to: the daemon's HTTP API, or the demo build's local walls. */
export interface WallBackend extends SyncApi {
  listWalls(): Promise<WallSummary[]>;
  createWall(input: { name: string; board?: Board }): Promise<Wall>;
  /** An independent copy of `sourceId` under a new id and name, with a fresh history. */
  cloneWall(sourceId: string, input: { id: string; name: string }): Promise<Wall>;
  deleteWall(id: string): Promise<void>;
  /** The latest history entries after revision `since` (the timeline). */
  history(id: string, since: number, limit: number): Promise<HistoryEntry[]>;
}

/** The wall the first edit continues on: the template's content under the new id and name, with a fresh history (rev 0). */
export function cloneOf(source: Wall, id: string, name: string): Wall {
  return { ...source, id, name, rev: 0 };
}

/** The longest wall name the daemon accepts (`CreateWallBodySchema`). */
const MAX_WALL_NAME = 200;

/** The name of a copy: `label(name)` (the template's name with the copy suffix), shortened to fit the limit by cutting the template's part. */
export function copyName(name: string, label: (name: string) => string): string {
  const overflow = label(name).length - MAX_WALL_NAME;
  return overflow <= 0 ? label(name) : label(name.slice(0, Math.max(name.length - overflow, 1)));
}

/** The backend of a clone being made, with a way to wait for the copy. */
export interface ForkApi extends SyncApi {
  /** Resolves once the copy exists on the service (a failed attempt is made again by the next call). */
  ready(): Promise<void>;
}

/**
 * The backend of a clone being made: the copy exists before the first call that reads or writes it is answered (a failed attempt, for
 * example offline, is made again by the next call). `onCreated` runs once the copy exists on the service.
 */
export function forkApi(
  backend: WallBackend,
  sourceId: string,
  clone: { readonly id: string; readonly name: string },
  onCreated: () => void,
): ForkApi {
  let created: Promise<void> | null = null;
  const start = (): Promise<void> =>
    backend.cloneWall(sourceId, clone).then(onCreated, (error: unknown) => {
      created = null;
      // The id is fresh, so a wall that exists under it is our own copy whose answer was lost.
      if (error instanceof ApiError && error.code === 'wall_exists') {
        created = Promise.resolve();
        onCreated();
      } else throw error;
    });
  const ready = (): Promise<void> => (created ??= start());
  return {
    ready,
    async getWall(id) {
      await ready();
      return backend.getWall(id);
    },
    async applyOps(id, ops, baseRev, label) {
      await ready();
      return backend.applyOps(id, ops, baseRev, label);
    },
    async undo(id, baseRev) {
      await ready();
      return backend.undo(id, baseRev);
    },
    async redo(id, baseRev) {
      await ready();
      return backend.redo(id, baseRev);
    },
  };
}
