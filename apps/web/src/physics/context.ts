/** The editor's live stores as the physics inputs: bank, tool library, tool interface, the open wall. */
import type { Op, Wall } from '@hsw-editor/core';
import { type BankState, bankStore } from '@/bank/client.ts';
import { type LibraryState, libraryStore, refreshToolLibrary } from '@/features/tools/store.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { toolInterfaceOf } from '@/wall/toolInterface.ts';
import { type AssetContext, EMPTY_LIBRARY } from './assets.ts';
import { physicsEnabledStore } from './enabled.ts';
import type { PostStepDeps } from './seat.ts';
import { physicsClient } from './service.ts';

export function currentWall(): Wall | null {
  return sessionStore.get()?.wall ?? null;
}

/** The physics inputs of `wall` from the given bank and library states; null until the bank is loaded (without holders nothing can be judged). */
export function physicsContext(
  wall: Wall,
  bank: BankState,
  library: LibraryState,
): AssetContext | null {
  if (bank.status !== 'ready') return null;
  return {
    bank: bank.byId,
    library:
      library.status === 'ready'
        ? { classes: library.classes, tools: library.tools }
        : EMPTY_LIBRARY,
    baseUrl: globalThis.location.href,
    toolInterface: (item) => toolInterfaceOf(item, wall, bank.index.toolClasses),
  };
}

/** `physicsContext` over the stores as they are now. */
export function liveContext(wall: Wall): AssetContext | null {
  return physicsContext(wall, bankStore.get(), libraryStore.get());
}

/** Do not hammer the server with a failing library request on every edit. */
const LIBRARY_RETRY_MS = 30_000;
let libraryTriedAt = 0;

/** Waits for the tool library (the generated models are found through it); a failed load is retried at most every 30 s. */
export async function ensureToolLibrary(): Promise<void> {
  const status = libraryStore.get().status;
  if (status === 'ready') return;
  if (status === 'error') {
    if (Date.now() - libraryTriedAt < LIBRARY_RETRY_MS) return;
    libraryTriedAt = Date.now();
  }
  await refreshToolLibrary();
}

export function livePostStepDeps(): PostStepDeps {
  return {
    wall: currentWall,
    context: liveContext,
    ranker: physicsClient,
    submit: (ops: readonly Op[], label: string) => {
      try {
        return submitOps(ops, label).ok;
      } catch {
        // The wall was closed while the worker was busy.
        return false;
      }
    },
    enabled: () => physicsEnabledStore.get(),
  };
}
