/** The photo.clean job against an in-memory wall and a fake draw backend: real pixels, real sharp, no daemon. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type DrawBackendId, type DrawRequest, type DrawResult } from '@hsw-editor/draw';
import {
  type Actor,
  type Op,
  type Photo,
  type Wall,
  applyOp,
  createEmptyWall,
} from '@hsw-editor/core';
import {
  boardExtent,
  boardFootprintPx,
  calibrateTwoPoint,
  photoMapFromCalibration,
  rasterisePolygon,
  toCoreCalibration,
} from '@hsw-editor/overlay';
import type { JobContext, JobWalls } from '../jobs.ts';
import type { AssetSlot, Outcome, WallState } from '../store/wall-store.ts';
import {
  MAX_COLOUR_OFF,
  MAX_OUTSIDE_DRIFT,
  type CleanDraw,
  pruneWorkDirs,
  runPhotoClean,
} from './job.ts';
import { encodeJpeg, encodePng, readPixels } from './pixels.ts';
import { cleanBackends } from './register.ts';

const WALL_ID = 'wall';
const WIDTH = 400;
const HEIGHT = 300;

/** A light wall with a gentle gradient and a dark "old board" in the middle. */
async function makePhoto(path: string): Promise<void> {
  const data = new Uint8Array(WIDTH * HEIGHT * 3);
  // Sensor grain, like a real wall photo: the clean patch has to match it.
  let state = 11;
  const grain = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 4294967296 - 0.5) * 8;
  };
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const base = 205 + 20 * (x / WIDTH) - 15 * (y / HEIGHT);
      const dark = x > 120 && x < 280 && y > 90 && y < 210;
      for (let c = 0; c < 3; c += 1)
        data[(y * WIDTH + x) * 3 + c] = dark ? 40 : base - c * 5 + grain();
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, await encodeJpeg({ width: WIDTH, height: HEIGHT, data }));
}

class FakeWalls implements JobWalls {
  wall: Wall;
  applied: { ops: Op[]; label?: string | undefined }[] = [];
  private counter = 1;

  constructor(
    private readonly dir: string,
    calibrated: boolean,
    mmPerPx = 3,
  ) {
    const base = createEmptyWall(WALL_ID, 'Wall');
    const photo: Photo = {
      id: 'p-1',
      file: 'photos/p-1.jpg',
      mime: 'image/jpeg',
      width: WIDTH,
      height: HEIGHT,
      name: 'wall.jpg',
      origin: 'upload',
      ...(calibrated ? { calibration: FakeWalls.calibration(base, mmPerPx) } : {}),
    };
    this.wall = { ...base, photos: [photo] };
  }

  static calibration(wall: Wall, mmPerPx: number) {
    const extent = boardExtent(wall.board);
    return toCoreCalibration(
      calibrateTwoPoint(
        { a: [50, 250], b: [50 + 100 / mmPerPx, 250], realMm: 100 },
        { width: WIDTH, height: HEIGHT },
        extent,
      ),
    );
  }

  setScale(mmPerPx: number): void {
    const [photo] = this.wall.photos;
    if (!photo) return;
    this.wall = {
      ...this.wall,
      photos: this.wall.photos.map((entry) =>
        entry.id === photo.id
          ? { ...entry, calibration: FakeWalls.calibration(this.wall, mmPerPx) }
          : entry,
      ),
    };
  }

  async get(): Promise<WallState> {
    return { wall: this.wall, warnings: [], canUndo: false, canRedo: false };
  }

  async apply(
    _wallId: string,
    request: { ops: Op[]; actor: Actor; label?: string | undefined },
  ): Promise<Outcome> {
    this.applied.push({ ops: request.ops, label: request.label });
    for (const op of request.ops) this.wall = applyOp(this.wall, op).wall;
    const op = request.ops[0] as Op;
    return {
      changed: true,
      wall: this.wall,
      op,
      inverse: op,
      warnings: [],
      canUndo: true,
      canRedo: false,
      entry: undefined,
    };
  }

  async addAsset(_wallId: string, slot: AssetSlot): Promise<string> {
    const relative = `${slot.dir}/${slot.prefix ?? 'a'}-${this.counter++}.${slot.ext}`;
    mkdirSync(dirname(join(this.dir, relative)), { recursive: true });
    await Bun.write(join(this.dir, relative), slot.bytes);
    return relative;
  }

  removed: string[] = [];
  async removeAsset(_wallId: string, relative: string): Promise<void> {
    this.removed.push(relative);
  }
  async askUser(): Promise<never> {
    throw new Error('not used');
  }
}

interface FakeDraw extends CleanDraw {
  readonly calls: { backend: DrawBackendId; request: DrawRequest }[];
  mode: 'good' | 'redraw' | 'flat-white' | 'login' | 'quota' | 'unavailable-then-good';
  /** The mask image the model was given in its last call. */
  maskSeen?: Awaited<ReturnType<typeof readPixels>>;
  /** Runs while the "model" works: the user does something to the wall in the meantime. */
  during?: () => void;
  backends: readonly DrawBackendId[];
}

/** Median colour of the unmasked photo: the wall, for a model that paints it flat. */
function wallColour(photo: Uint8Array, mask: Uint8Array): [number, number, number] {
  const channel = (c: number): number => {
    const values: number[] = [];
    for (let i = 0; i < photo.length / 3; i += 7) {
      if ((mask[i * 3] ?? 0) <= 127) values.push(photo[i * 3 + c] ?? 0);
    }
    values.sort((a, b) => a - b);
    return values[values.length >> 1] ?? 200;
  };
  return [channel(0), channel(1), channel(2)];
}

/** Fills the masked area of the canvas photo with a flat colour, as a perfect model would. */
function fakeDraw(): FakeDraw {
  const draw: FakeDraw = {
    calls: [],
    mode: 'good',
    backends: ['omp', 'chatgpt-browser'],
    async order() {
      return this.backends;
    },
    async run(request, _signal, backend): Promise<DrawResult> {
      this.calls.push({ backend, request });
      this.during?.();
      const failure = (
        code: 'login_required' | 'quota_exhausted' | 'backend_unavailable',
      ): DrawResult => ({
        ok: false,
        backend,
        error: { code, message: code, retryable: false },
      });
      if (this.mode === 'login') return failure('login_required');
      if (this.mode === 'quota') return failure('quota_exhausted');
      if (this.mode === 'unavailable-then-good' && backend === 'omp')
        return failure('backend_unavailable');
      const photo = await readPixels(request.refs[0]?.path ?? '');
      const mask = await readPixels(request.refs[1]?.path ?? '');
      this.maskSeen = mask;
      const data = new Uint8Array(photo.data);
      const wall = wallColour(photo.data, mask.data);
      for (let i = 0; i < photo.width * photo.height; i += 1) {
        if (this.mode === 'redraw') {
          for (let c = 0; c < 3; c += 1) data[i * 3 + c] = 255 - (data[i * 3 + c] ?? 0);
        } else if ((mask.data[i * 3] ?? 0) > 127) {
          // A perfectly smooth patch in the wall's colour (a model that paints a clean, flat wall), or flat white.
          const [r, g, b] = this.mode === 'flat-white' ? [255, 255, 255] : wall;
          data[i * 3] = r;
          data[i * 3 + 1] = g;
          data[i * 3 + 2] = b;
        }
      }
      const path = join(request.outDir, 'edit.png');
      mkdirSync(request.outDir, { recursive: true });
      await Bun.write(path, await encodePng(data, photo.width, photo.height, 3));
      return {
        ok: true,
        backend,
        images: [
          {
            path,
            mime: 'image/png',
            bytes: 1,
            sha256: 'x',
            width: photo.width,
            height: photo.height,
          },
        ],
        meta: { elapsedMs: 1 },
      };
    },
  };
  return draw;
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'photo-clean-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function context(walls: FakeWalls): JobContext {
  return {
    id: 'job1',
    kind: 'photo.clean',
    wallId: WALL_ID,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    walls,
    home,
  };
}

async function setup(calibrated = true) {
  const dir = join(home, 'walls', WALL_ID);
  await makePhoto(join(dir, 'photos/p-1.jpg'));
  const walls = new FakeWalls(dir, calibrated);
  const draw = fakeDraw();
  const deps = { wallDir: () => dir, draw };
  const run = (method: 'auto' | 'basic' = 'auto', refresh = false) =>
    runPhotoClean(deps, { wallId: WALL_ID, photoId: 'p-1', method, refresh }, context(walls));
  return { dir, walls, draw, run };
}

function footprintMask(walls: FakeWalls): Uint8Array {
  const photo = walls.wall.photos[0];
  if (!photo?.calibration) throw new Error('no calibration');
  const extent = boardExtent(walls.wall.board);
  const map = photoMapFromCalibration(photo.calibration, { width: WIDTH, height: HEIGHT }, extent);
  const polygon = map && boardFootprintPx(map, extent);
  if (!polygon) throw new Error('no footprint');
  return rasterisePolygon(polygon, WIDTH, HEIGHT);
}

describe('photo.clean', () => {
  test('an uncalibrated photo has no footprint to clean', async () => {
    const { run, walls } = await setup(false);
    expect((await run()).status).toBe('needs_calibration');
    expect(walls.applied).toHaveLength(0);
  });

  test('an unknown photo is reported, nothing is written', async () => {
    const { walls, draw, dir } = await setup();
    const result = await runPhotoClean(
      { wallDir: () => dir, draw },
      { wallId: WALL_ID, photoId: 'nope', method: 'auto', refresh: false },
      context(walls),
    );
    expect(result.status).toBe('photo_not_found');
  });

  test('the basic clean adds a variant of the photo, leaves the original and cleans only the footprint', async () => {
    const { run, walls, dir } = await setup();
    const result = await run('basic');
    expect(result).toMatchObject({ status: 'ok', method: 'basic', ai: 'not-asked' });
    const [original, variant] = walls.wall.photos;
    expect(original?.id).toBe('p-1');
    expect(original?.file).toBe('photos/p-1.jpg');
    expect(variant).toMatchObject({
      cleanOf: 'p-1',
      view: 'clean',
      backend: 'basic',
      origin: 'generated',
    });
    expect(variant?.cleanFootprint).toMatch(/^400x300@12:/);
    expect(variant?.calibration).toBeUndefined();
    const before = await readPixels(join(dir, 'photos/p-1.jpg'));
    const after = await readPixels(join(dir, variant?.file ?? ''));
    const mask = footprintMask(walls);
    let cleanedDark = 0;
    let changedOutside = 0;
    for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
      if (mask[i]) {
        // The old dark board (luma 40) inside the footprint is gone.
        if ((after.data[i * 3] ?? 0) < 120) cleanedDark += 1;
      } else if (Math.abs((after.data[i * 3] ?? 0) - (before.data[i * 3] ?? 0)) > 6) {
        changedOutside += 1;
      }
    }
    expect(cleanedDark).toBe(0);
    // JPEG re-encoding and the seam feather move a thin band near the edge, nothing else.
    expect(changedOutside).toBeLessThan(WIDTH * HEIGHT * 0.02);
  });

  test('basic first, then the model: its answer replaces the basic variant inside the mask only', async () => {
    const { run, walls, draw, dir } = await setup();
    let basicFile = '';
    draw.during = () => {
      basicFile = walls.wall.photos.find((photo) => photo.backend === 'basic')?.file ?? '';
    };
    const result = await run();
    expect(result).toMatchObject({ status: 'ok', method: 'ai', ai: 'done' });
    expect(draw.calls[0]?.backend).toBe('omp');
    expect(draw.calls[0]?.request.refs).toHaveLength(2);
    // The mask the model gets is the footprint: white over it, black elsewhere (a scrambled mask would paint the wall).
    const maskRef = draw.maskSeen;
    if (!maskRef) throw new Error('the model saw no mask');
    const whites = maskRef.data.reduce((n, v, i) => (i % 3 === 0 && v > 200 ? n + 1 : n), 0);
    const blacks = maskRef.data.reduce((n, v, i) => (i % 3 === 0 && v < 55 ? n + 1 : n), 0);
    expect(whites + blacks).toBeGreaterThan(maskRef.width * maskRef.height * 0.97);
    expect(whites).toBeGreaterThan(maskRef.width * maskRef.height * 0.05);
    // Two writes: the basic variant, then remove-basic + add-ai in one batch.
    expect(walls.applied).toHaveLength(2);
    expect(walls.applied[1]?.ops.map((op) => op.type)).toEqual(['removePhoto', 'addPhoto']);
    const variants = walls.wall.photos.filter((photo) => photo.cleanOf === 'p-1');
    expect(variants).toHaveLength(1);
    expect(variants[0]?.backend).toBe('omp');
    const out = await readPixels(join(dir, variants[0]?.file ?? ''));
    const mask = footprintMask(walls);
    // The middle of the footprint is well inside the mask, far from the feathered seam.
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (let i = 0; i < mask.length; i += 1) {
      if (!mask[i]) continue;
      sumX += i % WIDTH;
      sumY += Math.floor(i / WIDTH);
      count += 1;
    }
    const middle = Math.round(sumY / count) * WIDTH + Math.round(sumX / count);
    // The patch is the wall's colour: within the colour tolerance of the basic fill the model's answer was held against.
    const basic = await readPixels(join(dir, basicFile));
    expect(Math.abs((out.data[middle * 3] ?? 0) - (basic.data[middle * 3] ?? 0))).toBeLessThan(
      MAX_COLOUR_OFF,
    );
    expect(Math.abs((out.data[middle * 3] ?? 0) - 215)).toBeLessThan(30);
  });

  test('a model that paints a flat white is dropped: the wall under the board is never a white rectangle', async () => {
    const { run, walls, draw } = await setup();
    draw.mode = 'flat-white';
    const result = await run();
    expect(result).toMatchObject({ method: 'basic', ai: 'rejected' });
    expect(result.aiMessage).toContain('does not match the wall');
    expect(walls.wall.photos.find((photo) => photo.cleanOf)?.backend).toBe('basic');
  });

  test('a smooth patch in the wall colour gets the wall grain, so it is not a flat rectangle', async () => {
    const { run, walls, dir } = await setup();
    await run();
    const variant = walls.wall.photos.find((photo) => photo.cleanOf);
    const out = await readPixels(join(dir, variant?.file ?? ''));
    const mask = footprintMask(walls);
    // Grain = mean |pixel - 3x3 mean| (the metric the clean itself uses), inside the area and in the wall beside it.
    const grainOf = (pixels: typeof out, inside: boolean): number => {
      let sum = 0;
      let n = 0;
      for (let y = 20; y < 280; y += 2) {
        for (let x = 20; x < 380; x += 2) {
          const here = mask[y * WIDTH + x] === 1;
          const wallBeside = x < 100 || x > 300;
          if (inside ? !here || x < 130 || x > 270 || y < 100 || y > 200 : here || !wallBeside)
            continue;
          let around = 0;
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              around += pixels.data[((y + dy) * WIDTH + x + dx) * 3 + 1] ?? 0;
            }
          }
          sum += Math.abs((pixels.data[(y * WIDTH + x) * 3 + 1] ?? 0) - around / 9);
          n += 1;
        }
      }
      return n === 0 ? 0 : sum / n;
    };
    const wallGrain = grainOf(out, false);
    const patchGrain = grainOf(out, true);
    expect(wallGrain).toBeGreaterThan(0.5);
    // A flat fill reads ~0 here (the JPEG of the variant keeps about half of the fine grain, the rest is the wall's).
    expect(patchGrain).toBeGreaterThan(0.2);
    expect(patchGrain).toBeGreaterThan(wallGrain * 0.25);
  });

  test('a backend that is not signed in leaves the basic variant and says why', async () => {
    const { run, walls, draw } = await setup();
    draw.mode = 'login';
    const result = await run();
    expect(result).toMatchObject({ status: 'ok', method: 'basic', ai: 'login_required' });
    expect(draw.calls.map((call) => call.backend)).toEqual(['omp', 'chatgpt-browser']);
    expect(walls.wall.photos.filter((photo) => photo.cleanOf === 'p-1')).toHaveLength(1);
  });

  test('an unavailable backend hands over to the next one, a quota stops the chain', async () => {
    const first = await setup();
    first.draw.mode = 'unavailable-then-good';
    expect(await first.run()).toMatchObject({ method: 'ai', ai: 'done' });
    expect(first.draw.calls.map((call) => call.backend)).toEqual(['omp', 'chatgpt-browser']);
    expect(first.walls.wall.photos.at(-1)?.backend).toBe('chatgpt-browser');

    const second = await setup();
    second.draw.mode = 'quota';
    expect(await second.run()).toMatchObject({ method: 'basic', ai: 'quota_exhausted' });
    expect(second.draw.calls).toHaveLength(1);
  });

  test('a model that redraws the whole photo is rejected and the basic variant stays', async () => {
    const { run, draw, walls } = await setup();
    draw.mode = 'redraw';
    const result = await run();
    expect(result).toMatchObject({ method: 'basic', ai: 'rejected' });
    expect(result.aiMessage).toContain('redrew');
    expect(MAX_OUTSIDE_DRIFT).toBeGreaterThan(0);
    expect(walls.wall.photos.find((photo) => photo.cleanOf)?.backend).toBe('basic');
  });

  test('method basic never calls the model, an empty backend list switches the AI off', async () => {
    const { run, draw } = await setup();
    await run('basic');
    expect(draw.calls).toHaveLength(0);
    const other = await setup();
    other.draw.backends = [];
    expect(await other.run()).toMatchObject({ method: 'basic', ai: 'disabled' });
  });

  test('an up-to-date variant is reused; a moved footprint makes a new one and drops the old', async () => {
    const { run, walls, draw } = await setup();
    await run('basic');
    const first = walls.wall.photos.find((photo) => photo.cleanOf);
    expect(await run('basic')).toMatchObject({ status: 'current', variantId: first?.id });
    expect(walls.applied).toHaveLength(1);

    // Asking for the AI upgrades the basic variant without redoing the basic one.
    expect(await run()).toMatchObject({ method: 'ai', ai: 'done' });
    expect(draw.calls).toHaveLength(1);
    expect(await run()).toMatchObject({ status: 'current', method: 'ai' });
    expect(draw.calls).toHaveLength(1);

    walls.setScale(4.5);
    const moved = await run('basic');
    expect(moved).toMatchObject({ status: 'ok', method: 'basic' });
    expect(walls.wall.photos.filter((photo) => photo.cleanOf === 'p-1')).toHaveLength(1);
    expect(walls.wall.photos.find((photo) => photo.cleanOf)?.id).not.toBe(first?.id);
  });

  test('the basic variant undone while the model works: its answer is still stored, no failed removal', async () => {
    const { run, walls, draw } = await setup();
    draw.during = () => {
      const basic = walls.wall.photos.find((photo) => photo.cleanOf);
      if (basic) walls.wall = applyOp(walls.wall, { type: 'removePhoto', id: basic.id }).wall;
    };
    expect(await run()).toMatchObject({ status: 'ok', method: 'ai', ai: 'done' });
    const variants = walls.wall.photos.filter((photo) => photo.cleanOf === 'p-1');
    expect(variants.map((photo) => photo.backend)).toEqual(['omp']);
  });

  test('the board moved while the model worked: the answer is for the old footprint and is dropped', async () => {
    const { run, walls, draw } = await setup();
    draw.during = () => walls.setScale(4.5);
    const result = await run();
    expect(result.status).toBe('stale');
    expect(walls.removed).toHaveLength(1);
    // Only the basic variant (made before the move) is on the wall; nothing was swapped in for the new footprint.
    expect(
      walls.wall.photos.filter((photo) => photo.cleanOf === 'p-1').map((p) => p.backend),
    ).toEqual(['basic']);
  });

  test('a refresh keeps the AI variant when the model cannot answer, instead of trading it for a basic one', async () => {
    const { run, walls, draw } = await setup();
    await run();
    const ai = walls.wall.photos.find((photo) => photo.cleanOf);
    expect(ai?.backend).toBe('omp');
    draw.mode = 'login';
    const again = await run('auto', true);
    expect(again).toMatchObject({
      status: 'ok',
      method: 'ai',
      ai: 'login_required',
      variantId: ai?.id,
    });
    expect(walls.wall.photos.find((photo) => photo.cleanOf)?.id).toBe(ai?.id);
  });

  test('a basic refresh over an AI variant makes a new basic one, as asked', async () => {
    const { run, walls } = await setup();
    await run();
    expect(walls.wall.photos.find((photo) => photo.cleanOf)?.backend).toBe('omp');
    const result = await run('basic', true);
    expect(result).toMatchObject({ status: 'ok', method: 'basic', ai: 'not-asked' });
    expect(
      walls.wall.photos.filter((photo) => photo.cleanOf).map((photo) => photo.backend),
    ).toEqual(['basic']);
  });

  test('a nudge of the board while the model works does not throw its answer away', async () => {
    const { run, walls, draw } = await setup();
    // 3.0 -> 3.01 mm/px moves the footprint corners by a pixel or two: inside the material drift.
    draw.during = () => walls.setScale(3.01);
    const result = await run();
    expect(result).toMatchObject({ status: 'ok', method: 'ai', ai: 'done' });
  });

  test('a backend that left a failure screenshot keeps it; the big working copies and the rest are gone', async () => {
    const { run, draw } = await setup();
    draw.mode = 'login';
    draw.during = () => {
      mkdirSync(join(home, 'photo-clean', 'job1', 'out'), { recursive: true });
      writeFileSync(join(home, 'photo-clean', 'job1', 'out', 'chatgpt-browser-failure-1.png'), 'x');
      writeFileSync(join(home, 'photo-clean', 'job1', 'out', '.omp-draw-overlay.yml'), 'x');
    };
    await run();
    expect(
      existsSync(join(home, 'photo-clean', 'job1', 'out', 'chatgpt-browser-failure-1.png')),
    ).toBe(true);
    expect(existsSync(join(home, 'photo-clean', 'job1', 'out', '.omp-draw-overlay.yml'))).toBe(
      false,
    );
    expect(existsSync(join(home, 'photo-clean', 'job1', 'photo.png'))).toBe(false);
    expect(existsSync(join(home, 'photo-clean', 'job1', 'mask.png'))).toBe(false);
  });

  test('a logged-out run leaves no directory behind', async () => {
    const { run, draw } = await setup();
    draw.mode = 'login';
    await run();
    expect(existsSync(join(home, 'photo-clean', 'job1'))).toBe(false);
  });

  test('a backend that throws after the files exist: they are cleaned and the real error comes out', async () => {
    const { run, draw } = await setup();
    draw.run = async () => {
      // The working copies are on disk by now, and the backend left a sub-directory in out/.
      expect(existsSync(join(home, 'photo-clean', 'job1', 'photo.png'))).toBe(true);
      mkdirSync(join(home, 'photo-clean', 'job1', 'out', 'scratch'), { recursive: true });
      throw new Error('backend crashed');
    };
    await expect(run()).rejects.toThrow('backend crashed');
    expect(existsSync(join(home, 'photo-clean', 'job1'))).toBe(false);
  });

  test('kept failure directories are pruned after a week', async () => {
    const old = join(home, 'photo-clean', 'old-job');
    const fresh = join(home, 'photo-clean', 'fresh-job');
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const now = Date.now();
    utimesSync(old, (now - 8 * 24 * 3600 * 1000) / 1000, (now - 8 * 24 * 3600 * 1000) / 1000);
    await pruneWorkDirs(join(home, 'photo-clean'), now);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('the working files of an AI run are removed afterwards', async () => {
    const { run } = await setup();
    await run();
    expect(existsSync(join(home, 'photo-clean', 'job1'))).toBe(false);
  });

  test('asking to clean the variant cleans the photo it came from', async () => {
    const { walls, draw, dir } = await setup();
    const deps = { wallDir: () => dir, draw };
    await runPhotoClean(
      deps,
      { wallId: WALL_ID, photoId: 'p-1', method: 'basic', refresh: false },
      context(walls),
    );
    const variant = walls.wall.photos.find((photo) => photo.cleanOf);
    const again = await runPhotoClean(
      deps,
      { wallId: WALL_ID, photoId: variant?.id ?? '', method: 'basic', refresh: false },
      context(walls),
    );
    expect(again).toMatchObject({ status: 'current', variantId: variant?.id });
  });
});

describe('cleanBackends', () => {
  test('auto tries omp then the browser, a pinned backend is the only one, manual never runs automatically', () => {
    expect(cleanBackends('auto')).toEqual(['omp', 'chatgpt-browser']);
    expect(cleanBackends('omp')).toEqual(['omp']);
    expect(cleanBackends('chatgpt-browser')).toEqual(['chatgpt-browser']);
    expect(cleanBackends('manual')).toEqual([]);
  });
});
