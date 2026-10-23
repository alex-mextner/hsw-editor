import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '@/api/http.ts';
import { t } from '@/i18n/index.ts';
import { findToolsStore, isUnavailable, resetFindTools, runFindTools } from './findTools.ts';
import { leavePhotoMode, patchPhoto } from '@/state/photo.ts';
import { discardAllGhosts, ghostStore, setGhosts } from './visionGhosts.ts';

const realFetch = globalThis.fetch;
beforeEach(() => {
  patchPhoto({ photoId: 'p-7' });
});
afterEach(() => {
  leavePhotoMode();
  globalThis.fetch = realFetch;
  resetFindTools();
  discardAllGhosts();
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
      const job =
        call === 1
          ? { id: 'j1', state: 'queued' }
          : { id: 'j1', state: 'succeeded', result: { image: { w: 100, h: 80 }, objects: [] } };
      return Promise.resolve(new Response(JSON.stringify({ job }), { status: 200 }));
    }) as unknown as typeof fetch;
    await runFindTools('w', 'p-7');
    expect(findToolsStore.get()).toEqual({ phase: 'done', found: 0, unrecognised: 0 });
  });

  test('the objects of a finished job become ghosts of that photo, unrecognised ones are only counted', async () => {
    const objects = [
      {
        id: 3,
        bboxXywh: [10, 20, 30, 60],
        class: { toolClass: 'pliers', label: 'pliers', prob: 0.7 },
        confidence: 0.5,
        status: 'ok',
        dimensionsMm: { length: 180, width: 70, thickness: 25 },
      },
      {
        id: 4,
        bboxXywh: [100, 20, 30, 60],
        class: { toolClass: null, label: null, prob: null },
        confidence: 0.2,
        status: 'ok',
        dimensionsMm: null,
      },
    ];
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            job: { id: 'j2', state: 'succeeded', result: { image: { w: 200, h: 100 }, objects } },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    await runFindTools('w', 'p-7');
    expect(findToolsStore.get()).toEqual({ phase: 'done', found: 1, unrecognised: 1 });
    expect(ghostStore.get().photoId).toBe('p-7');
    expect(ghostStore.get().ghosts.map((ghost) => ghost.toolClass)).toEqual(['pliers']);
  });

  test('a failed re-run does not leave the previous proposals on the photo', async () => {
    setGhosts('p-7', []);
    expect(ghostStore.get().photoId).toBe('p-7');
    answer(500, { error: { code: 'boom', message: 'vision crashed' } });
    await runFindTools('w', 'p-7');
    expect(ghostStore.get()).toEqual({ photoId: null, ghosts: [] });
  });

  test('a search that finishes after the user moved to another photo proposes nothing', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            job: { id: 'j4', state: 'succeeded', result: { image: { w: 10, h: 10 }, objects: [] } },
          }),
          { status: 200 },
        ),
      )) as unknown as typeof fetch;
    const search = runFindTools('w', 'p-7');
    patchPhoto({ photoId: 'p-8' });
    await search;
    expect(findToolsStore.get()).toEqual({ phase: 'idle' });
    expect(ghostStore.get()).toEqual({ photoId: null, ghosts: [] });
  });

  test('a succeeded job without a recognisable result is a failure, not an empty success', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ job: { id: 'j3', state: 'succeeded', result: 'nope' } }), {
          status: 200,
        }),
      )) as unknown as typeof fetch;
    await runFindTools('w', 'p-7');
    expect(findToolsStore.get()).toEqual({
      phase: 'failed',
      message: t('photo.findTools.badResult'),
    });
  });

  test('only the unknown_job_kind code means unavailable', () => {
    expect(isUnavailable(new ApiError(400, 'unknown_job_kind', 'x', null))).toBe(true);
    expect(isUnavailable(new ApiError(400, 'other', 'x', null))).toBe(false);
    expect(isUnavailable(new Error('x'))).toBe(false);
  });
});
