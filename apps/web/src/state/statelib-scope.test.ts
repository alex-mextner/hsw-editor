import { describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// vendor/state-lib is private and absent in CI, and Vite (not Bun) maps its package name: the test runs only
// where the backend is installed and points the bare name at the built dist, so imports below are dynamic.
const dist = fileURLToPath(new URL('../../../../vendor/state-lib/dist/index.js', import.meta.url));

describe.skipIf(!existsSync(dist))('state-lib scope', () => {
  test('a subscriber may write another store while being notified', async () => {
    const lib: object = await import(dist);
    mock.module('@ultrabricks/state-lib', () => lib);
    const { createScope } = await import('./statelib-scope.ts');
    const scope = createScope();
    const source = scope.value<number>(0);
    const mirror = scope.value<number>(0);
    const stop = source.subscribe(() => mirror.set(source.get() * 2));
    expect(() => source.set(3)).not.toThrow();
    await Promise.resolve();
    expect(mirror.get()).toBe(6);
    stop();
  });

  test('an unsubscribed listener is not called by a pending delivery', async () => {
    const lib: object = await import(dist);
    mock.module('@ultrabricks/state-lib', () => lib);
    const { createScope } = await import('./statelib-scope.ts');
    const scope = createScope();
    const source = scope.value<number>(0);
    let calls = 0;
    const stop = source.subscribe(() => {
      calls += 1;
    });
    source.set(1);
    stop();
    await Promise.resolve();
    expect(calls).toBe(0);
  });
});
