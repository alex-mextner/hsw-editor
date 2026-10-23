/**
 * Runs the physics check of the open wall (in a Web Worker) and publishes it to `physicsStore`: `running` (keeping the
 * last report as `previous`), then `ready` or `error`. Only the newest run publishes: a check that finished after a
 * newer one started is dropped, so a report never shows for a wall that has already changed.
 */
import type { Wall } from '@hsw-editor/core';
import { buildPhysicsScene, type AssetContext } from './assets.ts';
import type { PhysicsChecker } from './client.ts';
import { currentWall, ensureToolModels, liveContext } from './context.ts';
import { physicsClient } from './service.ts';
import { physicsStore, reportOf } from './store.ts';

export interface RunDeps {
  readonly wall: () => Wall | null;
  readonly context: (wall: Wall) => AssetContext | null;
  readonly checker: () => PhysicsChecker;
  readonly ensureModels: () => Promise<void>;
  readonly now: () => number;
}

const liveDeps: RunDeps = {
  wall: currentWall,
  context: liveContext,
  checker: physicsClient,
  ensureModels: ensureToolModels,
  now: Date.now,
};

/** Newest run id; a run publishes only while it is still the newest. */
let latest = 0;
/** Signature of the scene the newest run checks: an unforced run of an identical scene is skipped. */
let latestSignature: string | null = null;

export interface RunOptions {
  /** Run even when the wall looks exactly like the one last checked (an explicit "check now"). */
  readonly force?: boolean;
}

/** Forgets the report and cancels the publishing of runs in flight (checks switched off, wall closed). */
export function clearPhysics(): void {
  latest += 1;
  latestSignature = null;
  if (physicsStore.get().status !== 'idle') physicsStore.set({ status: 'idle' });
}

/**
 * Checks the current wall. Never rejects: a failure is published as `status: 'error'`. Resolves when this run's
 * answer has been published (or dropped because a newer run superseded it).
 */
export async function runPhysicsWith(deps: RunDeps, options: RunOptions = {}): Promise<void> {
  const wall = deps.wall();
  if (wall === null) {
    clearPhysics();
    return;
  }
  try {
    await deps.ensureModels();
    const ctx = deps.context(wall);
    if (ctx === null) {
      // The bank is not loaded: nothing can be judged yet; the live hook runs again when it is.
      if (options.force === true)
        physicsStore.set({ status: 'error', message: 'the holder bank is not loaded yet' });
      return;
    }
    const { scene, sources } = buildPhysicsScene(wall, ctx);
    const signature = JSON.stringify(scene);
    if (options.force !== true && signature === latestSignature) return;
    latestSignature = signature;
    const id = ++latest;
    physicsStore.set({ status: 'running', previous: reportOf(physicsStore.get()) });
    if (scene.tools.length === 0) {
      physicsStore.set({ status: 'ready', report: { tools: [], flagged: 0 }, at: deps.now() });
      return;
    }
    try {
      const { report } = await deps.checker().check(scene, sources);
      if (id === latest) physicsStore.set({ status: 'ready', report, at: deps.now() });
    } catch (error) {
      if (id !== latest) return;
      // The next unforced run must retry instead of believing this scene was checked.
      latestSignature = null;
      physicsStore.set({ status: 'error', message: messageOf(error) });
    }
  } catch (error) {
    physicsStore.set({ status: 'error', message: messageOf(error) });
  }
}

/** Checks the open wall now (the palette command and the live hook). */
export function runPhysicsCheck(options: RunOptions = { force: true }): Promise<void> {
  return runPhysicsWith(liveDeps, options);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
