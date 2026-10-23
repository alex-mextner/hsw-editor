import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@/api/http.ts';
import { findToolsStore, isUnavailable, resetFindTools, runFindTools } from './findTools.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  resetFindTools();
});

function answer(status: number, body: unknown): void {
  globalThis.fetch = (() =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;
}

describe('find tools', () => {
  test('a daemon without the vision job is "not available", not an error', async () => {
    answer(400, { error: { code: 'unknown_job_kind', message: 'no such job' } });
    await runFindTools('w', 'p');
    expect(findToolsStore.get()).toEqual({ phase: 'unavailable' });
  });

  test('any other failure keeps its message', async () => {
    answer(500, { error: { code: 'boom', message: 'vision crashed' } });
    await runFindTools('w', 'p');
    expect(findToolsStore.get()).toEqual({ phase: 'failed', message: 'vision crashed' });
  });

  test('a finished job ends in done', async () => {
    let call = 0;
    globalThis.fetch = (() => {
      call += 1;
      const job = { id: 'j1', state: call === 1 ? 'queued' : 'succeeded' };
      return Promise.resolve(new Response(JSON.stringify({ job }), { status: 200 }));
    }) as unknown as typeof fetch;
    await runFindTools('w', 'p');
    expect(findToolsStore.get()).toEqual({ phase: 'done' });
  });

  test('only the unknown_job_kind code means unavailable', () => {
    expect(isUnavailable(new ApiError(400, 'unknown_job_kind', 'x', null))).toBe(true);
    expect(isUnavailable(new ApiError(400, 'other', 'x', null))).toBe(false);
    expect(isUnavailable(new Error('x'))).toBe(false);
  });
});
