import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DrawError } from '@hsw-editor/draw';
import { acquireOwnerLock } from './owner-lock.ts';
import { type Scratch, scratchDir } from './test-helpers.ts';

let scratch: Scratch;
beforeEach(async () => {
  scratch = await scratchDir();
});
afterEach(() => scratch.cleanup());

test('a live foreign owner blocks; release frees; a dead owner is taken over', async () => {
  const file = `${scratch.dir}/owner.lock`;
  const sleeper = Bun.spawn(['sleep', '30']);
  try {
    await Bun.write(file, `${sleeper.pid}:foreign`);
    const blocked = await acquireOwnerLock(file, 'test browser').catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(DrawError);
    expect((blocked as DrawError).code).toBe('backend_unavailable');
    expect((blocked as DrawError).message).toContain(String(sleeper.pid));
  } finally {
    sleeper.kill();
    await sleeper.exited;
  }
  // owner is dead now: stale lock is replaced
  const lock = await acquireOwnerLock(file, 'test browser');
  expect(await Bun.file(file).text()).toStartWith(`${process.pid}:`);
  await lock.release();
  expect(await Bun.file(file).exists()).toBe(false);
});

test('release never deletes a lock somebody else holds now', async () => {
  const file = `${scratch.dir}/owner.lock`;
  const lock = await acquireOwnerLock(file, 'test browser');
  await Bun.write(file, '999999:someone-else'); // lock was taken over after we were judged stale
  await lock.release();
  expect(await Bun.file(file).text()).toBe('999999:someone-else');
});

test('a lock held by this very process is never mistaken for a stale leftover', async () => {
  const file = `${scratch.dir}/owner.lock`;
  const first = await acquireOwnerLock(file, 'test browser');
  const second = await acquireOwnerLock(file, 'test browser').catch((e: unknown) => e);
  expect(second).toBeInstanceOf(DrawError);
  expect((second as DrawError).message).toContain('already in use by this process');
  await first.release();
  await (await acquireOwnerLock(file, 'test browser')).release();
});

test('concurrent in-process acquisition: exactly one winner, and the loser cannot unlink its lock', async () => {
  const file = `${scratch.dir}/owner.lock`;
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => acquireOwnerLock(file, 'test browser')),
  );
  const winners = results.filter((r) => r.status === 'fulfilled');
  expect(winners).toHaveLength(1);
  expect(await Bun.file(file).exists()).toBe(true);
  if (winners[0]?.status === 'fulfilled') await winners[0].value.release();
  expect(await Bun.file(file).exists()).toBe(false);
});
