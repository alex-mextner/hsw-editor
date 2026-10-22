import { describe, expect, test } from 'bun:test';
import { DrawError } from '@hsw-editor/draw';
import {
  DAY_MS,
  EMPTY_GUARD,
  GuardStore,
  LOGIN_RECHECK_MS,
  applyFailure,
  gate,
  recordHealthy,
  recordSend,
} from './guard.ts';
import { scratchDir } from './test-helpers.ts';

const config = { minIntervalMs: 60_000, dailyCap: 3 };
const T0 = 1_000_000_000_000;

describe('guard state machine', () => {
  test('first send goes immediately; the next must wait out the human-pace gap', () => {
    expect(gate(EMPTY_GUARD, config, T0, 1)).toEqual({ kind: 'go', waitMs: 0 });
    const afterSend = recordSend(EMPTY_GUARD, T0);
    expect(gate(afterSend, config, T0 + 20_000, 1)).toEqual({ kind: 'go', waitMs: 40_000 });
  });

  test('quota message blocks until the parsed reset time, then clears itself', () => {
    const blocked = applyFailure(
      EMPTY_GUARD,
      new DrawError('quota_exhausted', 'limit resets in 2 hours', { retryAfterMs: 7_200_000 }),
      T0,
    );
    const decision = gate(blocked, config, T0 + 1000, 1);
    expect(decision).toMatchObject({
      kind: 'blocked',
      code: 'quota_exhausted',
      retryAfterMs: 7_199_000,
    });
    expect(gate(blocked, config, T0 + 7_200_001, 1).kind).toBe('go');
  });

  test('quota without a stated reset blocks for an hour and never less than a minute', () => {
    const unknown = applyFailure(EMPTY_GUARD, new DrawError('quota_exhausted', 'limit'), T0);
    expect(unknown.blockedUntil).toBe(T0 + 3_600_000);
    const tiny = applyFailure(
      EMPTY_GUARD,
      new DrawError('quota_exhausted', 'x', { retryAfterMs: 5 }),
      T0,
    );
    expect(tiny.blockedUntil).toBe(T0 + 60_000);
  });

  test('daily cap counts a request of n sends and rolls off after 24h', () => {
    let guard = EMPTY_GUARD;
    for (const offset of [0, 70_000]) guard = recordSend(guard, T0 + offset);
    expect(gate(guard, config, T0 + 200_000, 2)).toMatchObject({
      kind: 'blocked',
      code: 'quota_exhausted',
    });
    expect(gate(guard, config, T0 + 200_000, 1).kind).toBe('go');
    expect(gate(guard, config, T0 + DAY_MS + 80_000, 3).kind).toBe('go');
  });

  test('challenge blocks until a healthy probe clears it; login block expires for a re-check', () => {
    const challenged = applyFailure(EMPTY_GUARD, new DrawError('challenge', 'captcha'), T0);
    expect(gate(challenged, config, T0 + DAY_MS, 1)).toMatchObject({
      kind: 'blocked',
      code: 'challenge',
    });
    expect(gate(recordHealthy(challenged, T0 + 5), config, T0 + 10, 1).kind).toBe('go');

    const loggedOut = applyFailure(EMPTY_GUARD, new DrawError('login_required', 'x'), T0);
    expect(gate(loggedOut, config, T0 + 1000, 1)).toMatchObject({
      kind: 'blocked',
      code: 'login_required',
    });
    expect(gate(loggedOut, config, T0 + LOGIN_RECHECK_MS + 1, 1).kind).toBe('go');
  });

  test('other failures leave the guard untouched', () => {
    expect(applyFailure(EMPTY_GUARD, new DrawError('refused', 'no'), T0)).toBe(EMPTY_GUARD);
  });
});

describe('GuardStore persistence', () => {
  test('concurrent updates from one process never drop a send', async () => {
    const scratch = await scratchDir();
    try {
      const store = new GuardStore(`${scratch.dir}/guard.json`);
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          store.update(i % 2 === 0 ? 'omp' : 'chatgpt-browser', (g) => recordSend(g, T0 + i)),
        ),
      );
      const book = await store.load();
      expect(book.omp.sends).toHaveLength(13);
      expect(book['chatgpt-browser'].sends).toHaveLength(12);
    } finally {
      await scratch.cleanup();
    }
  });

  test('survives a restart and tolerates a corrupt file', async () => {
    const scratch = await scratchDir();
    try {
      const file = `${scratch.dir}/guard.json`;
      await new GuardStore(file).update('chatgpt-browser', (g) =>
        applyFailure(
          recordSend(g, T0),
          new DrawError('quota_exhausted', 'limit', { retryAfterMs: 600_000 }),
          T0,
        ),
      );
      const reloaded = await new GuardStore(file).get('chatgpt-browser');
      expect(reloaded.sends).toEqual([T0]);
      expect(reloaded.blockedUntil).toBe(T0 + 600_000);
      expect((await new GuardStore(file).get('omp')).blockedUntil).toBe(0);

      await Bun.write(file, '{not json');
      expect(await new GuardStore(file).get('chatgpt-browser')).toEqual(EMPTY_GUARD);
    } finally {
      await scratch.cleanup();
    }
  });
});
