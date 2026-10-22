import { expect, test } from 'bun:test';
import { createValueStore } from './baseline.ts';

test('value store notifies subscribers only on change', () => {
  const store = createValueStore<string | null>(null);
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.set('w1');
  store.set('w1');
  expect(store.get()).toBe('w1');
  expect(calls).toBe(1);
  off();
  store.set('w2');
  expect(calls).toBe(1);
});
