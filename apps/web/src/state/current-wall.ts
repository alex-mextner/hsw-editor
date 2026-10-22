import { createValueStore } from '#state-backend';

const STORAGE_KEY = 'hsw-editor.currentWallId';

function readPersisted(): string | null {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Id of the wall open in the editor; persisted so a reload (or offline start) reopens it. */
export const currentWallId = createValueStore<string | null>(readPersisted());

currentWallId.subscribe(() => {
  try {
    const id = currentWallId.get();
    if (id === null) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, id);
  } catch {
    // Storage may be unavailable (private mode); the in-memory store still works.
  }
});
