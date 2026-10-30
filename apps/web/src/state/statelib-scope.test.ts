import { describe, expect, test } from 'bun:test';
import { createScope } from './statelib-scope.ts';

describe('state-lib scope', () => {
  test('a subscriber may write another store while being notified', async () => {
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
