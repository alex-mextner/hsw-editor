import { beforeEach, describe, expect, test } from 'bun:test';
import type { Wall } from '@hsw-editor/core';
import type { WallPhysicsReport } from '@hsw-editor/physics';
import type { PhysicsChecker, WallCheck } from './client.ts';
import { clearPhysics, type RunDeps, runPhysicsWith } from './run.ts';
import { physicsStore } from './store.ts';
import { contextOf, holderItem, toolItem, wallOf } from './testWall.testkit.ts';

const REPORT: WallPhysicsReport = { tools: [], flagged: 0 };
const OTHER: WallPhysicsReport = { tools: [], flagged: 3 };

function setup(wall: Wall | null, check: PhysicsChecker['check']) {
  const calls: number[] = [];
  let ensured = 0;
  const deps: RunDeps = {
    wall: () => wall,
    context: (w) => contextOf(w),
    checker: () => ({
      check: (scene, sources) => {
        calls.push(scene.tools.length);
        return check(scene, sources);
      },
    }),
    ensureLibrary: async () => {
      ensured += 1;
    },
    now: () => 42,
  };
  return { deps, calls, ensured: () => ensured };
}

const hungWall = (): Wall => {
  const driver = toolItem('drv', { parentId: 'h', slot: 0 });
  return wallOf([holderItem('h', 'rack')], [driver]);
};
const ok = (report: WallPhysicsReport): Promise<WallCheck> =>
  Promise.resolve({ report, skipped: [] });

beforeEach(() => clearPhysics());

describe('runPhysicsWith', () => {
  test('running (with the previous report), then ready', async () => {
    const slow = Promise.withResolvers<WallCheck>();
    const started = Promise.withResolvers<void>();
    const { deps } = setup(hungWall(), () => {
      started.resolve();
      return slow.promise;
    });
    physicsStore.set({ status: 'ready', report: OTHER, at: 1 });
    const running = runPhysicsWith(deps, { force: true });
    await started.promise;
    expect(physicsStore.get()).toEqual({ status: 'running', previous: OTHER });
    slow.resolve({ report: REPORT, skipped: [] });
    await running;
    expect(physicsStore.get()).toEqual({ status: 'ready', report: REPORT, at: 42 });
  });

  test('a failure is published as an error and never thrown', async () => {
    const { deps } = setup(hungWall(), () => Promise.reject(new Error('worker died')));
    await runPhysicsWith(deps, { force: true });
    expect(physicsStore.get()).toEqual({ status: 'error', message: 'worker died' });
  });

  test('a wall without hung tools needs no worker', async () => {
    const { deps, calls } = setup(wallOf([holderItem('h', 'rack')], []), () => ok(OTHER));
    await runPhysicsWith(deps, { force: true });
    expect(calls).toEqual([]);
    expect(physicsStore.get()).toEqual({
      status: 'ready',
      report: { tools: [], flagged: 0 },
      at: 42,
    });
  });

  test('an unchanged wall is not checked again unless forced', async () => {
    const wall = hungWall();
    const { deps, calls } = setup(wall, () => ok(REPORT));
    await runPhysicsWith(deps);
    await runPhysicsWith(deps);
    expect(calls).toHaveLength(1);
    await runPhysicsWith(deps, { force: true });
    expect(calls).toHaveLength(2);
  });

  test('after a failure the same wall is tried again', async () => {
    let fail = true;
    const { deps, calls } = setup(hungWall(), () =>
      fail ? Promise.reject(new Error('nope')) : ok(REPORT),
    );
    await runPhysicsWith(deps);
    fail = false;
    await runPhysicsWith(deps);
    expect(calls).toHaveLength(2);
    expect(physicsStore.get().status).toBe('ready');
  });

  test('only the newest run publishes: a slow older answer is dropped', async () => {
    const wall = hungWall();
    const first = Promise.withResolvers<WallCheck>();
    let n = 0;
    const { deps } = setup(wall, () => {
      n += 1;
      return n === 1 ? first.promise : ok(OTHER);
    });
    const older = runPhysicsWith(deps, { force: true });
    await Promise.resolve();
    await runPhysicsWith(deps, { force: true });
    expect(physicsStore.get()).toMatchObject({ status: 'ready', report: OTHER });
    first.resolve({ report: REPORT, skipped: [] });
    await older;
    expect(physicsStore.get()).toMatchObject({ status: 'ready', report: OTHER });
  });

  test('no open wall clears the report', async () => {
    physicsStore.set({ status: 'ready', report: OTHER, at: 1 });
    const { deps } = setup(null, () => ok(REPORT));
    await runPhysicsWith(deps, { force: true });
    expect(physicsStore.get()).toEqual({ status: 'idle' });
  });

  test('a bank that is not loaded is an error for an explicit run, silence for the live one', async () => {
    const { deps } = setup(hungWall(), () => ok(REPORT));
    const noBank: RunDeps = { ...deps, context: () => null };
    await runPhysicsWith(noBank);
    expect(physicsStore.get()).toEqual({ status: 'idle' });
    await runPhysicsWith(noBank, { force: true });
    expect(physicsStore.get().status).toBe('error');
  });

  test('the tool library is awaited before the scene is built', async () => {
    const { deps, ensured } = setup(hungWall(), () => ok(REPORT));
    await runPhysicsWith(deps, { force: true });
    expect(ensured()).toBe(1);
  });
});
