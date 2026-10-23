import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD, createEmptyWall, type Photo, type Wall } from '@hsw-editor/core';
import {
  boardExtent,
  boardFootprintPx,
  calibrateTwoPoint,
  footprintSignature,
  photoMapFromCalibration,
  toCoreCalibration,
} from '@hsw-editor/overlay';
import { cleanStore, forgetAsked, planClean, resetClean, runClean } from './cleanBackground.ts';

const image = { width: 1400, height: 1000 };
const realFetch = globalThis.fetch;

function wallWith(extra: Photo[] = [], mmPerPx = 1): Wall {
  const base = createEmptyWall('w', 'Wall');
  const extent = boardExtent(DEFAULT_BOARD);
  const calibration = toCoreCalibration(
    calibrateTwoPoint({ a: [100, 800], b: [100 + 800 / mmPerPx, 800], realMm: 800 }, image, extent),
  );
  const original: Photo = {
    id: 'p-1',
    file: 'photos/p-1.jpg',
    mime: 'image/jpeg',
    width: image.width,
    height: image.height,
    origin: 'upload',
    calibration,
  };
  return { ...base, photos: [original, ...extra] };
}

function signatureOf(wall: Wall): string {
  const original = wall.photos[0];
  if (!original?.calibration) throw new Error('fixture');
  const extent = boardExtent(wall.board);
  const map = photoMapFromCalibration(original.calibration, image, extent);
  const polygon = map && boardFootprintPx(map, extent);
  if (!polygon) throw new Error('fixture');
  return footprintSignature(polygon, image);
}

function variant(wall: Wall, backend: string): Photo {
  return {
    id: 'p-2',
    file: 'photos/derived/clean-1.jpg',
    mime: 'image/jpeg',
    width: image.width,
    height: image.height,
    origin: 'generated',
    view: 'clean',
    backend,
    cleanOf: 'p-1',
    cleanFootprint: signatureOf(wall),
  };
}

beforeEach(() => forgetAsked('p-1'));
afterEach(() => {
  globalThis.fetch = realFetch;
  resetClean();
  forgetAsked('p-1');
});

describe('planClean', () => {
  test('a calibrated photo without a variant needs one, and the signature is the footprint', () => {
    const wall = wallWith();
    const plan = planClean(wall, 'p-1');
    expect(plan?.needsClean).toBe(true);
    expect(plan?.signature).toBe(signatureOf(wall));
  });

  test('an uncalibrated photo, an unknown photo and a variant itself are not planned', () => {
    const wall = wallWith();
    const [original] = wall.photos;
    if (!original) throw new Error('fixture');
    const { calibration: _dropped, ...bare } = original;
    expect(planClean({ ...wall, photos: [bare] }, 'p-1')).toBeNull();
    expect(planClean(wall, 'nope')).toBeNull();
    expect(planClean({ ...wall, photos: [original, variant(wall, 'basic')] }, 'p-2')).toBeNull();
  });

  test('a basic variant for this footprint is current but asks for the AI upgrade once', () => {
    const bare = wallWith();
    const wall = { ...bare, photos: [...bare.photos, variant(bare, 'basic')] };
    expect(planClean(wall, 'p-1')).toMatchObject({ needsClean: false, needsUpgrade: true });
  });

  test('an AI variant for this footprint needs nothing', () => {
    const bare = wallWith();
    const wall = { ...bare, photos: [...bare.photos, variant(bare, 'omp')] };
    expect(planClean(wall, 'p-1')).toMatchObject({ needsClean: false, needsUpgrade: false });
  });

  test('a board that moved materially needs a new variant', () => {
    const bare = wallWith();
    const stale = variant(bare, 'omp');
    const moved = wallWith([stale], 2.5);
    expect(planClean(moved, 'p-1')).toMatchObject({ needsClean: true });
  });
});

function answerJob(result: unknown, state = 'succeeded'): void {
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ job: { id: 'j1', state, result } }), { status: 200 }),
    )) as unknown as typeof fetch;
}

describe('runClean', () => {
  test('a finished job ends in done with what the AI step came to', async () => {
    answerJob({
      status: 'ok',
      variantId: 'p-2',
      method: 'basic',
      ai: 'login_required',
      aiMessage: 'sign in',
    });
    await runClean('w', 'p-1', 'sig');
    expect(cleanStore.get()).toEqual({
      phase: 'done',
      photoId: 'p-1',
      method: 'basic',
      ai: 'login_required',
      aiMessage: 'sign in',
    });
  });

  test('the model is asked once per footprint: after a run the upgrade is not asked for again', async () => {
    const bare = wallWith();
    const wall = { ...bare, photos: [...bare.photos, variant(bare, 'basic')] };
    expect(planClean(wall, 'p-1')?.needsUpgrade).toBe(true);
    answerJob({ status: 'ok', variantId: 'p-2', method: 'basic', ai: 'login_required' });
    await runClean('w', 'p-1', signatureOf(bare));
    expect(planClean(wall, 'p-1')?.needsUpgrade).toBe(false);
    forgetAsked('p-1');
    expect(planClean(wall, 'p-1')?.needsUpgrade).toBe(true);
  });

  test('undoing the clean does not bring it straight back: a footprint is acted on once, a moved board is new', async () => {
    const bare = wallWith();
    expect(planClean(bare, 'p-1')?.needsClean).toBe(true);
    answerJob({ status: 'ok', variantId: 'p-2', method: 'basic', ai: 'not-asked' });
    await runClean('w', 'p-1', signatureOf(bare));
    // The variant is gone again (undo): same footprint, nothing to do by itself.
    expect(planClean(bare, 'p-1')?.needsClean).toBe(false);
    // The board moved: a new footprint is cleaned again.
    expect(planClean(wallWith([], 2.5), 'p-1')?.needsClean).toBe(true);
  });

  test('a failed job and an unreadable result are failures, an unknown job kind is unavailable', async () => {
    answerJob(undefined, 'failed');
    await runClean('w', 'p-1', 'sig');
    expect(cleanStore.get().phase).toBe('failed');
    resetClean();
    answerJob('garbage');
    await runClean('w', 'p-1', 'sig');
    expect(cleanStore.get()).toEqual({ phase: 'failed', photoId: 'p-1', message: null });
    resetClean();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'unknown_job_kind', message: 'x' } }), {
          status: 400,
        }),
      )) as unknown as typeof fetch;
    await runClean('w', 'p-1', 'sig');
    expect(cleanStore.get()).toEqual({ phase: 'unavailable' });
  });
});
