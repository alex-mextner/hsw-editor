/** The editor's live stores as the physics inputs: bank, generated tool models, tool interface, the open wall. */
import type { Op, Wall, WallItem } from '@hsw-editor/core';
import { type BankState, bankStore } from '@/bank/client.ts';
import { refreshToolAssets, toolAssetsStore } from '@/toolmodels/assets.ts';
import { toolModelVersion } from '@/toolmodels/regen.ts';
import { resolveToolModel, type ResolveDeps } from '@/toolmodels/resolve.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { toolInterfaceOf } from '@/wall/toolInterface.ts';
import type { AssetContext, ToolModelSource } from './assets.ts';
import { physicsEnabledStore } from './enabled.ts';
import type { PostStepDeps } from './seat.ts';
import { physicsClient } from './service.ts';

export function currentWall(): Wall | null {
  return sessionStore.get()?.wall ?? null;
}

/**
 * The model the scene draws for a tool, as the physics fetches it: the same `resolveToolModel` answer, so the tool that is
 * judged is the tool on screen at its size. A model still being built for the item's size is not judged yet (null): the
 * live check runs again when it lands (`toolModelVersion`).
 */
export function liveToolModel(
  wall: Wall,
  item: WallItem,
  deps?: ResolveDeps,
): ToolModelSource | null {
  const model = resolveToolModel(item, wall, deps);
  return model === null || model.pending ? null : { key: model.key, path: model.lod1 };
}

/** The physics inputs of `wall` from the given bank state; null until the bank is loaded (without holders nothing can be judged). */
export function physicsContext(wall: Wall, bank: BankState): AssetContext | null {
  if (bank.status !== 'ready') return null;
  return {
    bank: bank.byId,
    toolModel: (item) => liveToolModel(wall, item),
    baseUrl: globalThis.location.href,
    toolInterface: (item) => toolInterfaceOf(item, wall, bank.index.toolClasses),
  };
}

/** `physicsContext` over the stores as they are now. */
export function liveContext(wall: Wall): AssetContext | null {
  return physicsContext(wall, bankStore.get());
}

/** Do not hammer the server with a failing index request on every edit. */
const MODELS_RETRY_MS = 30_000;

/** Waits for the tool model index (which generator draws which tool is found through it); a failed load is retried at most every 30 s. */
export async function ensureToolModels(): Promise<void> {
  const state = toolAssetsStore.get();
  if (state.status === 'ready') return;
  if (state.status === 'error' && Date.now() - state.at < MODELS_RETRY_MS) return;
  await refreshToolAssets();
}

/** How long a rebuild is waited for; a slower one leaves the tool where it is. */
export const MODEL_WAIT_MS = 8000;

function modelSettled(itemId: string): boolean {
  const wall = currentWall();
  const item = wall?.items.find((candidate) => candidate.id === itemId);
  if (!wall || !item) return true;
  const source = resolveToolModel(item, wall);
  return source === null || !source.pending;
}

/** Resolves true once the model of the tool is no longer being rebuilt (at once when it is not), false when that took too long. */
export function untilToolModelSettled(itemId: string): Promise<boolean> {
  if (modelSettled(itemId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (settled: boolean): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(settled);
    };
    const unsubscribe = toolModelVersion.subscribe(() => {
      if (modelSettled(itemId)) finish(true);
    });
    const timer = setTimeout(() => finish(false), MODEL_WAIT_MS);
  });
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
    settled: untilToolModelSettled,
  };
}
