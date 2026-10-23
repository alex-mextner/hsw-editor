/** Job handlers against a fake VisionClient and an in-memory wall (no sidecar, no store). */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import {
  type Actor,
  type InputRequest,
  type JsonValue,
  type LeafOp,
  type NewInputRequest,
  type Op,
  type Wall,
  createEmptyWall,
} from '@hsw-editor/core';
import type { AssetSlot, Outcome, WallState } from '../store/wall-store.ts';
import type { JobContext, JobProgress, JobRegistry, JobWalls } from '../jobs.ts';
import type { ServiceRequest, VisionClient, VisionStatus } from './client.ts';
import { registerVisionJobs, stableStringify } from './jobs.ts';
import {
  type CalibrationResult,
  type FitResult,
  type PhotoToObjectsResult,
  type PhotoToWallResult,
  type SegmentResult,
  type StreamEvent,
  VisionError,
} from './types.ts';

const WALL_ID = 'garage';
const PHOTO_ID = 'p-1';

interface Harness {
  readonly home: string;
  readonly wallDir: string;
  readonly imageDir: string;
  readonly registry: JobRegistry;
  readonly client: FakeClient;
  readonly walls: FakeWalls;
  readonly progress: JobProgress[];
  run(kind: string, input: JsonValue): Promise<JsonValue>;
}

function toolOps(n: number): { item: LeafOp; ops: LeafOp[] } {
  const itemId = `vabc-0${n}`;
  const modelId = `mabc-0${n}`;
  const ops: LeafOp[] = [
    {
      type: 'addModelRef',
      model: {
        id: modelId,
        label: 'Screwdriver',
        status: 'candidate',
        source: { type: 'generated', by: 'hsw-vision' },
        forItemId: itemId,
        score: 0.9,
      },
    },
    {
      type: 'addItem',
      item: {
        id: itemId,
        kind: 'tool',
        modelRefId: modelId,
        label: 'Screwdriver',
        toolClass: 'screwdriver',
        pose: { x: 10, y: 20, z: 5, rotX: 0, rotY: 0, rotZ: 30 },
        params: { length: 200 },
        source: { type: 'vision', confidence: 0.9, photoId: PHOTO_ID, by: 'hsw-vision' },
        locked: false,
      },
    },
  ];
  return { item: ops[1] as LeafOp, ops };
}

function proposalItem(
  n: number,
  confidence: number,
  autoApply: boolean,
): Record<string, JsonValue> {
  const { ops } = toolOps(n);
  return {
    id: `vabc-0${n}`,
    modelId: `mabc-0${n}`,
    instanceId: n,
    label: 'Screwdriver',
    toolClass: 'screwdriver',
    confidence,
    status: 'ok',
    autoApply,
    needsView: confidence < 0.75,
    glb: `models/fit-00${n}.glb`,
    ops: JSON.parse(JSON.stringify(ops)) as JsonValue,
  };
}

function okResult(imageDir: string, items: Record<string, JsonValue>[]): PhotoToWallResult {
  const raw = {
    status: 'ok',
    image: { sha256: 'a'.repeat(64), w: 100, h: 80 },
    calibration: {
      ok: true,
      method: 'two-point',
      mm_per_px: 1.5,
      core: { method: 'two-point', mmPerPx: 1.5, focalPx: 400 },
    },
    work: { imageDir },
    proposal: {
      version: 1,
      photoId: PHOTO_ID,
      autoApplyConfidence: null,
      items,
      holders: [],
      ops: [],
      summary: { objects: items.length },
    },
    events: [],
    diagnostics: { timing_s: { total: 1 } },
  };
  return JSON.parse(JSON.stringify(raw)) as PhotoToWallResult;
}

class FakeClient implements VisionClient {
  photoToWallCalls: ServiceRequest[] = [];
  photoToObjectsCalls: ServiceRequest[] = [];
  objectsResults: (PhotoToObjectsResult | VisionError)[] = [];
  calibrateCalls: ServiceRequest[] = [];
  fitCalls: ServiceRequest[] = [];
  /** Results returned in order by `photoToWall`. */
  results: (PhotoToWallResult | VisionError)[] = [];
  events: StreamEvent[] = [];
  calibrateResult: CalibrationResult = {
    ok: true,
    method: 'two-point',
    mm_per_px: 1.5,
    core: { method: 'two-point', mmPerPx: 1.5 },
  };
  calibrateResults: CalibrationResult[] = [];
  segmentResult: SegmentResult | undefined;
  fitResult: FitResult | undefined;
  fitError: VisionError | undefined;

  async photoToWall(
    request: ServiceRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<PhotoToWallResult> {
    this.photoToWallCalls.push(request);
    for (const event of this.events) onEvent(event);
    const next = this.results.shift();
    if (next === undefined) throw new Error('no scripted result');
    if (next instanceof VisionError) throw next;
    return next;
  }

  async photoToObjects(
    request: ServiceRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<PhotoToObjectsResult> {
    this.photoToObjectsCalls.push(request);
    for (const event of this.events) onEvent(event);
    const next = this.objectsResults.shift();
    if (next === undefined) throw new Error('no scripted result');
    if (next instanceof VisionError) throw next;
    return next;
  }

  async calibrate(request: ServiceRequest): Promise<CalibrationResult> {
    this.calibrateCalls.push(request);
    return this.calibrateResults.shift() ?? this.calibrateResult;
  }

  async segment(): Promise<SegmentResult> {
    if (this.segmentResult === undefined) throw new Error('no segment result');
    return this.segmentResult;
  }

  async fit(request: ServiceRequest): Promise<FitResult> {
    this.fitCalls.push(request);
    if (this.fitError !== undefined && this.fitCalls.length === 1) throw this.fitError;
    if (this.fitResult === undefined) throw new Error('no fit result');
    return this.fitResult;
  }

  async post(): Promise<unknown> {
    throw new Error('not used');
  }

  async postStream(): Promise<unknown> {
    throw new Error('not used');
  }

  async status(): Promise<VisionStatus> {
    return {
      running: false,
      managed: false,
      endpoint: null,
      startable: false,
      health: null,
      models: null,
    };
  }

  async stop(): Promise<void> {}
}

class FakeWalls implements JobWalls {
  wall: Wall = createEmptyWall(WALL_ID, 'Garage');
  applied: { ops: Op[]; actor: Actor; label?: string | undefined }[] = [];
  assets: AssetSlot[] = [];
  asked: NewInputRequest[] = [];
  answers: Partial<InputRequest>[] = [];
  private nextAsset = 1;
  /** Assets the job deleted again. */
  removed: string[] = [];
  /** Makes every apply that is not the calibration fail (a rejected batch of proposal ops). */
  failBatchesWith: Error | undefined;

  constructor(private readonly dir: string) {
    this.wall = {
      ...this.wall,
      photos: [
        {
          id: PHOTO_ID,
          file: 'photos/p-1.jpg',
          mime: 'image/jpeg',
          width: 100,
          height: 80,
          origin: 'upload',
        },
      ],
    };
  }

  async get(): Promise<WallState> {
    return { wall: this.wall, warnings: [], canUndo: false, canRedo: false };
  }

  async apply(
    _wallId: string,
    request: { ops: Op[]; actor: Actor; label?: string | undefined },
  ): Promise<Outcome> {
    if (this.failBatchesWith !== undefined && request.ops[0]?.type !== 'setCalibration')
      throw this.failBatchesWith;
    this.applied.push(request);
    this.wall = { ...this.wall, rev: this.wall.rev + 1 };
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

  async removeAsset(_wallId: string, relative: string): Promise<void> {
    this.removed.push(relative);
    rmSync(join(this.dir, relative), { force: true });
  }

  async addAsset(_wallId: string, slot: AssetSlot): Promise<string> {
    this.assets.push(slot);
    const relative = `${slot.dir}/${slot.prefix ?? 'a'}-${this.nextAsset++}.${slot.ext}`;
    mkdirSync(join(this.dir, slot.dir), { recursive: true });
    writeFileSync(join(this.dir, relative), slot.bytes);
    return relative;
  }

  async askUser(_wallId: string, request: NewInputRequest): Promise<InputRequest> {
    this.asked.push(request);
    const answer = this.answers.shift() ?? { status: 'cancelled' };
    return {
      id: 'r-1',
      createdBy: { kind: 'agent' },
      createdAt: 'now',
      status: 'cancelled',
      ...request,
      ...answer,
    } as InputRequest;
  }
}

let home = '';

function harness(): Harness {
  const wallDir = join(home, 'walls', WALL_ID);
  const imageDir = join(home, 'image-dir');
  mkdirSync(join(wallDir, 'photos'), { recursive: true });
  mkdirSync(join(imageDir, 'models'), { recursive: true });
  writeFileSync(join(wallDir, 'photos', 'p-1.jpg'), 'jpeg-bytes');
  for (const n of [1, 2, 3]) writeFileSync(join(imageDir, 'models', `fit-00${n}.glb`), `glb-${n}`);
  const registry: JobRegistry = new Map();
  const client = new FakeClient();
  const walls = new FakeWalls(wallDir);
  const progress: JobProgress[] = [];
  registerVisionJobs(
    {
      client,
      wallDir: () => wallDir,
      bankIndex: async () => ({ contentHash: 'h1', toolClasses: [], elements: [] }),
    },
    registry,
  );
  return {
    home,
    wallDir,
    imageDir,
    registry,
    client,
    walls,
    progress,
    async run(kind, input) {
      const registered = registry.get(kind);
      if (registered === undefined) throw new Error(`no handler ${kind}`);
      const parsed = registered.parse(input);
      if (!parsed.ok) throw new Error(`invalid input: ${parsed.issues.join('; ')}`);
      const ctx: JobContext = {
        id: 'j1',
        kind,
        wallId: WALL_ID,
        signal: new AbortController().signal,
        progress: (update) => progress.push(update),
        log: () => {},
        home,
        walls,
      };
      return parsed.run(ctx);
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hsw-vision-jobs-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function objectOf(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('not an object');
  return value;
}

describe('vision.photo_to_wall', () => {
  test('rejects malformed input at the schema', async () => {
    const h = harness();
    await expect(h.run('vision.photo_to_wall', { wallId: WALL_ID })).rejects.toThrow(
      'invalid input',
    );
    await expect(
      h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID, bogus: 1 }),
    ).rejects.toThrow('invalid input');
    await expect(
      h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID, autoApplyConfidence: 2 }),
    ).rejects.toThrow('invalid input');
  });

  test('registers the five job kinds', () => {
    expect([...harness().registry.keys()].sort()).toEqual([
      'vision.calibrate',
      'vision.fit',
      'vision.photo_to_objects',
      'vision.photo_to_wall',
      'vision.segment',
    ]);
  });

  test('proposes without applying: assets stored, model files filled, nothing but the calibration applied', async () => {
    const h = harness();
    h.client.results.push(
      okResult(h.imageDir, [proposalItem(1, 0.9, false), proposalItem(2, 0.6, false)]),
    );
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(out['status']).toBe('ok');
    expect(out['applied']).toBeNull();
    // only the calibration op went through the store
    expect(h.walls.applied).toHaveLength(1);
    expect(h.walls.applied[0]?.ops[0]?.type).toBe('setCalibration');
    expect(h.walls.applied[0]?.actor).toEqual({ kind: 'agent', name: 'vision' });
    expect(out['calibrationApplied']).toBe(true);
    // glbs stored through ctx.walls.addAsset into models/, bytes from the sidecar's image dir
    expect(h.walls.assets.map((a) => [a.dir, a.ext])).toEqual([
      ['models', 'glb'],
      ['models', 'glb'],
    ]);
    expect(new TextDecoder().decode(h.walls.assets[0]?.bytes)).toBe('glb-1');
    const proposal = objectOf(out['proposal'] ?? null);
    const items = proposal['items'] as Record<string, JsonValue>[];
    const modelOp = objectOf(((items[0] ?? {})['ops'] as JsonValue[])[0] ?? null);
    expect(objectOf(modelOp['model'] ?? null)['file']).toBe('models/m-1.glb');
    expect((proposal['ops'] as JsonValue[]).length).toBe(4);
  });

  test('auto mode applies only the flagged items as one batch with the vision actor', async () => {
    const h = harness();
    h.client.results.push(
      okResult(h.imageDir, [
        proposalItem(1, 0.95, true),
        proposalItem(2, 0.6, false),
        proposalItem(3, 0.97, true),
      ]),
    );
    const out = objectOf(
      await h.run('vision.photo_to_wall', {
        wallId: WALL_ID,
        photoId: PHOTO_ID,
        autoApplyConfidence: 0.9,
      }),
    );
    const batch = h.walls.applied.find((a) => a.ops[0]?.type === 'addModelRef');
    expect(batch?.ops.map((op) => op.type)).toEqual([
      'addModelRef',
      'addItem',
      'addModelRef',
      'addItem',
    ]);
    expect(batch?.actor).toEqual({ kind: 'agent', name: 'vision' });
    expect(objectOf(out['applied'] ?? null)['itemIds']).toEqual(['vabc-01', 'vabc-03']);
    expect(h.client.photoToWallCalls[0]?.['auto_apply_confidence']).toBe(0.9);
    const items = objectOf(out['proposal'] ?? null)['items'] as Record<string, JsonValue>[];
    expect(items.map((i) => i['applied'])).toEqual([true, false, true]);
  });

  test('a re-run that proposes ids already on the wall does not add them again (no failed job)', async () => {
    const h = harness();
    const first = [proposalItem(1, 0.95, true), proposalItem(3, 0.97, true)];
    h.client.results.push(okResult(h.imageDir, first));
    await h.run('vision.photo_to_wall', {
      wallId: WALL_ID,
      photoId: PHOTO_ID,
      autoApplyConfidence: 0.9,
    });
    // the same objects are on the wall now; the second run (other parameters => no job-cache hit) proposes them again plus a new one
    h.walls.wall = {
      ...h.walls.wall,
      items: [
        ...h.walls.wall.items,
        ...first
          .map((p) => (p['ops'] as LeafOp[]).find((op) => op.type === 'addItem'))
          .flatMap((op) => (op?.type === 'addItem' ? [op.item] : [])),
      ],
      models: [
        ...h.walls.wall.models,
        ...first
          .map((p) => (p['ops'] as LeafOp[]).find((op) => op.type === 'addModelRef'))
          .flatMap((op) => (op?.type === 'addModelRef' ? [op.model] : [])),
      ],
    };
    h.client.results.push(okResult(h.imageDir, [...first, proposalItem(2, 0.99, true)]));
    const out = objectOf(
      await h.run('vision.photo_to_wall', {
        wallId: WALL_ID,
        photoId: PHOTO_ID,
        autoApplyConfidence: 0.8,
      }),
    );
    expect(objectOf(out['applied'] ?? null)['itemIds']).toEqual(['vabc-02']);
  });

  test('the default request never asks the service to auto-apply and passes board, bank and overrides', async () => {
    const h = harness();
    h.client.results.push(okResult(h.imageDir, []));
    await h.run('vision.photo_to_wall', {
      wallId: WALL_ID,
      photoId: PHOTO_ID,
      fixedDims: { '1': { length: 160 } },
      calibrate: {
        pointsPx: [
          [0, 0],
          [100, 0],
        ],
        distanceMm: 150,
      },
      segment: { method: 'u2net' },
    });
    const request = h.client.photoToWallCalls[0] as ServiceRequest;
    expect(request['auto_apply_confidence']).toBeUndefined();
    expect(request['fixed_dims']).toEqual({ '1': { length: 160 } });
    expect(request['calibrate']).toEqual({
      points_px: [
        [0, 0],
        [100, 0],
      ],
      distance_mm: 150,
    });
    expect(request['segment']).toEqual({ method: 'u2net' });
    expect(request['image_path']).toBe(join(h.wallDir, 'photos', 'p-1.jpg'));
    expect(request['work_dir']).toBe(join(h.wallDir, 'vision'));
    expect((request['board'] as Record<string, JsonValue>)['cols']).toBe(48);
    expect(request['photo_id']).toBe(PHOTO_ID);
  });

  test('is idempotent: the same photo and parameters return the stored result without calling the service', async () => {
    const h = harness();
    h.client.results.push(okResult(h.imageDir, [proposalItem(1, 0.9, false)]));
    const first = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    const second = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(h.client.photoToWallCalls).toHaveLength(1);
    expect(first['cached']).toBe(false);
    expect(second['cached']).toBe(true);
    expect(h.walls.assets).toHaveLength(1); // the glb is not stored twice
    expect(second['proposal']).toEqual(first['proposal']);
    // different parameters are a different result
    h.client.results.push(okResult(h.imageDir, []));
    await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID, maxObjects: 5 });
    expect(h.client.photoToWallCalls).toHaveLength(2);
    // refresh forces a new run
    h.client.results.push(okResult(h.imageDir, []));
    await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID, refresh: true });
    expect(h.client.photoToWallCalls).toHaveLength(3);
  });

  test('a stored result whose asset was deleted is recomputed', async () => {
    const h = harness();
    h.client.results.push(okResult(h.imageDir, [proposalItem(1, 0.9, false)]));
    await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID });
    rmSync(join(h.wallDir, 'models'), { recursive: true, force: true });
    h.client.results.push(okResult(h.imageDir, [proposalItem(1, 0.9, false)]));
    await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID });
    expect(h.client.photoToWallCalls).toHaveLength(2);
    expect(readdirSync(join(h.wallDir, 'models'))).toHaveLength(1);
  });

  test('a failed apply removes the model files it created (not the ones an earlier run handed out) and reports the original error', async () => {
    const h = harness();
    h.client.results.push(okResult(h.imageDir, [proposalItem(1, 0.9, false)]));
    await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }); // m-1.glb is out there now
    writeFileSync(join(h.imageDir, 'models', 'fit-002.glb'), 'glb-2-new');
    h.client.results.push(
      okResult(h.imageDir, [proposalItem(1, 0.95, true), proposalItem(2, 0.96, true)]),
    );
    h.walls.failBatchesWith = new Error('item_exists');
    await expect(
      h.run('vision.photo_to_wall', {
        wallId: WALL_ID,
        photoId: PHOTO_ID,
        autoApplyConfidence: 0.9,
      }),
    ).rejects.toThrow('item_exists');
    expect(h.walls.assets).toHaveLength(2); // m-1 (first run) and m-2 (created by the failed run)
    expect(h.walls.removed).toEqual(['models/m-2.glb']);
    expect(readdirSync(join(h.wallDir, 'models'))).toEqual(['m-1.glb']);
  });

  test('a damaged asset ledger is treated as empty instead of failing the job', async () => {
    const h = harness();
    mkdirSync(join(h.wallDir, 'vision'), { recursive: true });
    writeFileSync(join(h.wallDir, 'vision', 'assets.json'), '{"models:abc": ');
    h.client.results.push(okResult(h.imageDir, [proposalItem(1, 0.9, false)]));
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(out['status']).toBe('ok');
    expect(h.walls.assets).toHaveLength(1);
  });

  test('a failing photo_to_wall never deletes a model file a concurrent vision.fit was just handed', async () => {
    const h = harness();
    h.client.fitResult = {
      instance: 1,
      fit: { glb: 'models/fit-001.glb' }, // the same bytes photo_to_wall stores for item 1
      dimensionsMm: { length_mm: 160 },
      confidence: 0.82,
      residual: 0.07,
      imageDir: h.imageDir,
    };
    h.client.results.push(okResult(h.imageDir, [proposalItem(1, 0.95, true)]));
    h.walls.failBatchesWith = new Error('item_exists');
    const [wall, fit] = await Promise.allSettled([
      h.run('vision.photo_to_wall', {
        wallId: WALL_ID,
        photoId: PHOTO_ID,
        autoApplyConfidence: 0.9,
      }),
      h.run('vision.fit', {
        wallId: WALL_ID,
        photoId: PHOTO_ID,
        instance: 1,
        calibrate: { mmPerPx: 1.5 },
      }),
    ]);
    expect(wall.status).toBe('rejected');
    if (fit.status !== 'fulfilled') throw new Error('the fit job failed');
    const modelFile = objectOf(fit.value)['modelFile'];
    expect(typeof modelFile).toBe('string');
    expect(readdirSync(join(h.wallDir, 'models'))).toContain(basename(String(modelFile)));
  });

  test('a re-run that fits the same objects reuses the stored model files; changed content gets a new file and nothing is deleted', async () => {
    const h = harness();
    const items = () => [proposalItem(1, 0.9, false), proposalItem(2, 0.9, false)];
    h.client.results.push(okResult(h.imageDir, items()));
    const first = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    h.client.results.push(okResult(h.imageDir, items()));
    const again = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID, refresh: true }),
    );
    const files = (out: Record<string, JsonValue>): JsonValue[] =>
      z
        .array(z.json())
        .parse(objectOf(out['proposal'] ?? null)['ops'])
        .map((op) => objectOf(op))
        .filter((op) => op['type'] === 'addModelRef')
        .map((op) => objectOf(op['model'] ?? null)['file'] ?? null);
    expect(files(first)).toEqual(['models/m-1.glb', 'models/m-2.glb']);
    expect(files(again)).toEqual(files(first)); // same bytes: the same files
    expect(h.walls.assets).toHaveLength(2);

    // the fit of object 2 changed: it gets its own file, the earlier one stays where the caller was told it is
    writeFileSync(join(h.imageDir, 'models', 'fit-002.glb'), 'glb-2-better');
    h.client.results.push(okResult(h.imageDir, items()));
    const changed = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID, refresh: true }),
    );
    expect(files(changed)).toEqual(['models/m-1.glb', 'models/m-3.glb']);
    expect(h.walls.removed).toEqual([]);
    expect(readdirSync(join(h.wallDir, 'models')).sort()).toEqual([
      'm-1.glb',
      'm-2.glb',
      'm-3.glb',
    ]);
  });

  test('maps service events onto job progress, request_view travels as a data payload', async () => {
    const h = harness();
    h.client.events = [
      { event: 'stage', stage: 'calibrate', state: 'start' },
      { event: 'stage', stage: 'segment', state: 'done' },
      { event: 'object', state: 'fitted', instanceId: 4, done: 1, total: 2 },
      {
        type: 'request_view',
        reason: 'low_confidence',
        items: [{ itemId: 'vabc-01', confidence: 0.4 }],
        suggested: [],
      },
    ];
    h.client.results.push(okResult(h.imageDir, []));
    await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID });
    const messages = h.progress.map((p) => p.message);
    expect(messages).toContain('calibrate…');
    expect(messages).toContain('segment done');
    expect(h.progress.find((p) => p.done === 1 && p.total === 2)?.fraction).toBeCloseTo(0.725);
    const viewRequest = h.progress.find(
      (p) => (p.data as Record<string, JsonValue> | undefined)?.['type'] === 'request_view',
    );
    expect(viewRequest?.message).toContain('another view');
    expect(h.progress.at(-1)?.fraction).toBe(1);
  });

  test('without a scale it opens a calibration request and re-runs with the answered two points', async () => {
    const h = harness();
    const needs = okResult(h.imageDir, []);
    h.client.results.push({
      ...needs,
      status: 'needs_calibration',
      proposal: null,
      calibration: { ok: false, needs: 'scale', message: 'no grid and no manual scale' },
    });
    h.client.results.push(okResult(h.imageDir, [proposalItem(1, 0.9, false)]));
    h.walls.answers.push({
      status: 'answered',
      answer: {
        pointsPx: [
          [10, 10],
          [110, 10],
        ],
        distanceMm: 250,
      },
    });
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(h.walls.asked).toHaveLength(1);
    expect(h.walls.asked[0]).toMatchObject({
      kind: 'calibration',
      photoId: PHOTO_ID,
      payload: { photoId: PHOTO_ID, mode: 'two-point' },
    });
    expect(h.client.photoToWallCalls[1]?.['calibrate']).toEqual({
      mode: 'two-point',
      points_px: [
        [10, 10],
        [110, 10],
      ],
      distance_mm: 250,
    });
    expect(out['status']).toBe('ok');
  });

  test('the last scale attempt does not open a question whose answer would be thrown away', async () => {
    const h = harness();
    const needs = (): PhotoToWallResult => ({
      ...okResult(h.imageDir, []),
      status: 'needs_calibration',
      proposal: null,
      calibration: { ok: false, needs: 'scale', message: 'still no scale' },
    });
    h.client.results.push(needs(), needs(), needs());
    for (let i = 0; i < 3; i++)
      h.walls.answers.push({ status: 'answered', answer: { mmPerPx: 1 + i } });
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(out['status']).toBe('needs_calibration');
    expect(h.client.photoToWallCalls).toHaveLength(3);
    expect(h.walls.asked).toHaveLength(2);
    expect(h.walls.answers).toHaveLength(1); // the third answer was never requested
  });

  test('a cancelled calibration request ends as needs_calibration, not as a failure', async () => {
    const h = harness();
    const needs = okResult(h.imageDir, []);
    h.client.results.push({
      ...needs,
      status: 'needs_calibration',
      proposal: null,
      calibration: { ok: false, needs: 'scale', message: 'no scale' },
    });
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(out['status']).toBe('needs_calibration');
    expect(h.client.photoToWallCalls).toHaveLength(1);
    expect(h.walls.assets).toHaveLength(0);
  });

  test('askUser: false never opens a request', async () => {
    const h = harness();
    const needs = okResult(h.imageDir, []);
    h.client.results.push({
      ...needs,
      status: 'needs_calibration',
      proposal: null,
      calibration: { ok: false, needs: 'scale', message: 'no scale' },
    });
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID, askUser: false }),
    );
    expect(out['status']).toBe('needs_calibration');
    expect(h.walls.asked).toHaveLength(0);
  });

  test('service errors fail the job with the remedy, e.g. models_missing -> fetch-models', async () => {
    const h = harness();
    h.client.results.push(
      new VisionError('models_missing', 'model sam2-tiny is missing', {
        fix: 'hsw-editor vision fetch-models',
        status: 424,
      }),
    );
    await expect(
      h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    ).rejects.toThrow('model sam2-tiny is missing (fix: hsw-editor vision fetch-models)');
  });

  test('an unknown photo or a missing photo file fails clearly', async () => {
    const h = harness();
    await expect(
      h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: 'p-nope' }),
    ).rejects.toThrow('not on wall');
    rmSync(join(h.wallDir, 'photos', 'p-1.jpg'));
    await expect(
      h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    ).rejects.toThrow('missing on disk');
  });

  test('a scale the photo already carries from the user is handed to the service and not re-applied as a `manual` calibration', async () => {
    const h = harness();
    h.walls.wall = {
      ...h.walls.wall,
      photos: h.walls.wall.photos.map((p) => ({
        ...p,
        calibration: { method: 'two-point' as const, mmPerPx: 1.5, focalPx: 400 },
      })),
    };
    const result = okResult(h.imageDir, []);
    // the service echoes a scale given as `mm_per_px` as a `manual` calibration
    h.client.results.push({
      ...result,
      calibration: {
        ...result.calibration,
        core: { method: 'manual', mmPerPx: 1.5, focalPx: 400 },
      },
    });
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(h.client.photoToWallCalls[0]?.['calibrate']).toEqual({ mm_per_px: 1.5 });
    expect(out['calibrationApplied']).toBe(false);
    expect(h.walls.applied).toHaveLength(0);
  });

  test('an already identical calibration is not applied again', async () => {
    const h = harness();
    h.walls.wall = {
      ...h.walls.wall,
      photos: h.walls.wall.photos.map((p) => ({
        ...p,
        calibration: { method: 'two-point' as const, mmPerPx: 1.5, focalPx: 400 },
      })),
    };
    h.client.results.push(okResult(h.imageDir, []));
    const out = objectOf(
      await h.run('vision.photo_to_wall', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(out['calibrationApplied']).toBe(false);
    expect(h.walls.applied).toHaveLength(0);
  });
});

describe('stage jobs', () => {
  test('vision.calibrate applies the calibration and asks for a scale when none is found', async () => {
    const h = harness();
    const out = objectOf(await h.run('vision.calibrate', { wallId: WALL_ID, photoId: PHOTO_ID }));
    expect(out['status']).toBe('ok');
    expect(h.walls.applied[0]?.ops[0]).toMatchObject({ type: 'setCalibration', photoId: PHOTO_ID });

    const h2 = harness();
    h2.client.calibrateResults.push(
      { ok: false, needs: 'scale', message: 'no scale' },
      { ok: true, method: 'manual', mm_per_px: 1.25, core: { method: 'manual', mmPerPx: 1.25 } },
    );
    h2.walls.answers.push({ status: 'answered', answer: { mmPerPx: 1.25 } });
    const retried = objectOf(
      await h2.run('vision.calibrate', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(h2.walls.asked).toHaveLength(1);
    expect(h2.client.calibrateCalls[1]?.['calibrate']).toEqual({ mode: 'manual', mm_per_px: 1.25 });
    expect(retried['status']).toBe('ok');
    expect(h2.walls.applied[0]?.ops[0]).toMatchObject({
      type: 'setCalibration',
      calibration: { method: 'manual', mmPerPx: 1.25 },
    });
  });

  test('vision.calibrate that still has no scale after the third attempt returns needs_calibration instead of throwing', async () => {
    const h = harness();
    h.client.calibrateResults.push(
      { ok: false, needs: 'scale', message: 'no scale' },
      { ok: false, needs: 'scale', message: 'no scale' },
      { ok: false, needs: 'scale', message: 'no scale' },
    );
    for (let i = 0; i < 3; i++)
      h.walls.answers.push({ status: 'answered', answer: { mmPerPx: 1 + i } });
    const out = objectOf(await h.run('vision.calibrate', { wallId: WALL_ID, photoId: PHOTO_ID }));
    expect(out['status']).toBe('needs_calibration');
    expect(h.client.calibrateCalls).toHaveLength(3);
    expect(h.walls.asked).toHaveLength(2);
  });

  test('vision.segment stores the overlay as a derived asset and returns plain instances', async () => {
    const h = harness();
    mkdirSync(join(h.imageDir, 'seg-1'), { recursive: true });
    writeFileSync(join(h.imageDir, 'seg-1', 'overlay.jpg'), 'overlay');
    h.client.segmentResult = {
      image: { w: 100, h: 80, sha256: 'b'.repeat(64) },
      imageDir: h.imageDir,
      dir: 'seg-1',
      overlay: 'overlay.jpg',
      method: 'sam2+owlv2',
      instances: [
        {
          id: 1,
          bbox_xywh: [1, 2, 3, 4],
          area_px: 12,
          polygon: [
            [0, 0],
            [1, 1],
          ],
          mask: 'masks/001.png',
          bg_prob: 0.1,
        },
      ],
    };
    const out = objectOf(await h.run('vision.segment', { wallId: WALL_ID, photoId: PHOTO_ID }));
    expect(h.walls.assets[0]).toMatchObject({ dir: 'photos/derived', ext: 'jpg' });
    expect(out['overlay']).toBe('photos/derived/seg-1.jpg');
    expect((out['instances'] as Record<string, JsonValue>[])[0]).toEqual({
      id: 1,
      bbox_xywh: [1, 2, 3, 4],
      area_px: 12,
      polygon: [
        [0, 0],
        [1, 1],
      ],
      bg_prob: 0.1,
      stability: null,
    });
  });

  test('vision.fit passes user dimension overrides and stores the model', async () => {
    const h = harness();
    h.client.fitResult = {
      instance: 1,
      fit: { glb: 'models/fit-001.glb' },
      dimensionsMm: { length_mm: 160 },
      confidence: 0.82,
      residual: 0.07,
      imageDir: h.imageDir,
    };
    const out = objectOf(
      await h.run('vision.fit', {
        wallId: WALL_ID,
        photoId: PHOTO_ID,
        instance: 1,
        fixedDims: { length: 160 },
        calibrate: { mmPerPx: 1.5 },
      }),
    );
    expect(h.client.fitCalls[0]).toMatchObject({
      instance: 1,
      fixed_dims: { length: 160 },
      calibrate: { mm_per_px: 1.5 },
    });
    expect(out['modelFile']).toBe('models/m-1.glb');
    expect(out['confidence']).toBe(0.82);
  });

  test('repeated identical vision.fit runs reuse one stored model file', async () => {
    const h = harness();
    h.client.fitResult = {
      instance: 1,
      fit: { glb: 'models/fit-001.glb' },
      dimensionsMm: { length_mm: 160 },
      confidence: 0.82,
      residual: 0.07,
      imageDir: h.imageDir,
    };
    const input = { wallId: WALL_ID, photoId: PHOTO_ID, instance: 1, calibrate: { mmPerPx: 1.5 } };
    for (let run = 0; run < 3; run++)
      expect(objectOf(await h.run('vision.fit', input))['modelFile']).toBe('models/m-1.glb');
    expect(h.walls.assets).toHaveLength(1);
    // another fit of the same instance (other template) is another file; the first stays
    writeFileSync(join(h.imageDir, 'models', 'fit-001.glb'), 'glb-box');
    expect(objectOf(await h.run('vision.fit', input))['modelFile']).toBe('models/m-2.glb');
    expect(h.walls.removed).toEqual([]);
  });

  test('vision.fit asks for a scale when the sidecar reports calibration_needed, then retries', async () => {
    const h = harness();
    h.client.fitError = new VisionError('calibration_needed', 'no scale', { status: 422 });
    h.client.fitResult = {
      instance: 1,
      fit: {},
      dimensionsMm: {},
      confidence: 0.7,
      residual: null,
      imageDir: h.imageDir,
    };
    h.walls.answers.push({ status: 'answered', answer: { mmPerPx: 2 } });
    await h.run('vision.fit', { wallId: WALL_ID, photoId: PHOTO_ID, instance: 1 });
    expect(h.client.fitCalls).toHaveLength(2);
    expect(h.client.fitCalls[1]?.['calibrate']).toEqual({ mode: 'manual', mm_per_px: 2 });
  });
});

test('stableStringify is key-order independent', () => {
  expect(stableStringify({ b: 1, a: [{ d: 1, c: undefined }] })).toBe(
    stableStringify({ a: [{ d: 1 }], b: 1 }),
  );
});

function objectsResult(outDir: string, status: 'ok' | 'no_scale' = 'ok'): PhotoToObjectsResult {
  const record = {
    id: 7,
    bboxXywh: [1, 2, 30, 8],
    areaPx: 240,
    mask: 'masks/007.png',
    crop: { path: 'crops/007.png', boxXywh: [0, 0, 32, 10] },
    cutout: 'cutouts/007.png',
    cropOriented: 'crops_oriented/007.png',
    cutoutOriented: 'cutouts_oriented/007.png',
    axis: { deg: 3, unit: [1, 0.05] },
    profile: status === 'ok' ? { length_mm: 187, stations: [] } : null,
    mmPerPx: status === 'ok' ? 1.2 : null,
    class: {
      toolClass: 'screwdriver',
      prob: 0.8,
      topk: [{ toolClass: 'screwdriver', score: 27.9 }],
    },
    fit: status === 'ok' ? { glb: 'models/007.glb' } : null,
    dimensionsMm: status === 'ok' ? { length: 187, width: 8, thickness: 8 } : null,
    colours: null,
    embedding: { file: 'embeddings.npy', row: 0, dim: 512 },
    confidence: 0.6,
    needsView: true,
    needsViews: [{ azimuth_deg: 60, elevation_deg: 30 }],
    status: status === 'ok' ? 'ok' : 'no_scale',
    error: null,
  };
  return JSON.parse(
    JSON.stringify({
      version: 1,
      status,
      image: { sha256: 'a'.repeat(64), w: 100, h: 80 },
      outDir,
      calibration: { ok: status === 'ok', method: status === 'ok' ? 'manual' : null },
      summary: { found: 3, analysed: 1 },
      objects: [record],
      diagnostics: { timing_s: { total: 1 } },
    }),
  ) as PhotoToObjectsResult;
}

describe('vision.photo_to_objects', () => {
  test('takes a photo path (no wall) and writes nothing to any wall', async () => {
    const h = harness();
    const photoPath = join(home, 'loose.jpg');
    writeFileSync(photoPath, 'jpeg');
    const outDir = join(home, 'tool-library', 'screwdriver-1');
    h.client.objectsResults.push(objectsResult(outDir));
    h.client.events = [{ event: 'stage', stage: 'segment', state: 'done' }];
    const result = objectOf(
      await h.run('vision.photo_to_objects', {
        imagePath: photoPath,
        outDir,
        calibrate: { mmPerPx: 1.2 },
        categories: '/cats/tools.json',
        fixedDims: { '7': { length: 150 } },
        maxObjects: 5,
        extraImagePaths: [photoPath],
        colours: false,
        inlineEmbeddings: true,
      }),
    );
    expect(result['status']).toBe('ok');
    expect(result['outDir']).toBe(outDir);
    const request = h.client.photoToObjectsCalls[0] as ServiceRequest;
    expect(request).toEqual({
      image_path: photoPath,
      work_dir: join(home, 'vision', 'cache'),
      calibrate: { mm_per_px: 1.2 },
      segment: {},
      out_dir: outDir,
      categories: '/cats/tools.json',
      fixed_dims: { '7': { length: 150 } },
      max_objects: 5,
      colours: false,
      inline_embeddings: true,
      extra_photos: [photoPath],
    });
    expect(h.walls.applied).toHaveLength(0);
    expect(h.walls.assets).toHaveLength(0);
    expect(h.progress.some((p) => p.message === 'segment done')).toBe(true);
  });

  test('a wall photo is read from the wall and cached under the wall', async () => {
    const h = harness();
    h.client.objectsResults.push(objectsResult('/out', 'no_scale'));
    const result = objectOf(
      await h.run('vision.photo_to_objects', { wallId: WALL_ID, photoId: PHOTO_ID }),
    );
    expect(result['status']).toBe('no_scale');
    const request = h.client.photoToObjectsCalls[0] as ServiceRequest;
    expect(request['image_path']).toBe(join(h.wallDir, 'photos', 'p-1.jpg'));
    expect(request['work_dir']).toBe(join(h.wallDir, 'vision'));
    expect('out_dir' in request).toBe(false);
    expect('bank_index' in request).toBe(false);
  });

  test('useBank passes the bank index', async () => {
    const h = harness();
    h.client.objectsResults.push(objectsResult('/out'));
    await h.run('vision.photo_to_objects', { wallId: WALL_ID, photoId: PHOTO_ID, useBank: true });
    expect(h.client.photoToObjectsCalls[0]?.['bank_index']).toEqual({
      contentHash: 'h1',
      toolClasses: [],
      elements: [],
    });
  });

  test('needs exactly one photo source and absolute paths', async () => {
    const h = harness();
    for (const input of [
      {},
      { imagePath: '/a.jpg', wallId: WALL_ID, photoId: PHOTO_ID },
      { wallId: WALL_ID },
      { imagePath: 'relative.jpg' },
      { imagePath: '/a.jpg', outDir: 'relative' },
      { imagePath: '/a.jpg', bogus: 1 },
    ])
      await expect(h.run('vision.photo_to_objects', input)).rejects.toThrow('invalid input');
  });

  test('a missing photo file and a service failure are job failures with the fix', async () => {
    const h = harness();
    await expect(
      h.run('vision.photo_to_objects', { imagePath: join(home, 'nope.jpg') }),
    ).rejects.toThrow('does not exist');
    writeFileSync(join(home, 'there.jpg'), 'x');
    h.client.objectsResults.push(
      new VisionError('models_missing', 'sam2-tiny is missing', {
        fix: 'hsw-editor vision fetch-models',
      }),
    );
    await expect(
      h.run('vision.photo_to_objects', { imagePath: join(home, 'there.jpg') }),
    ).rejects.toThrow('hsw-editor vision fetch-models');
  });
});
