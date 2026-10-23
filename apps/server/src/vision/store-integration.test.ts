/**
 * The vision jobs against the real wall store behind the real server: upload a photo, calibrate it with two picked points,
 * check that the scale is recorded in the wall (as an undoable op by the vision actor) and used by the next fit.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WallSchema } from '@hsw-editor/core';
import { z } from 'zod';
import type { JobRegistry } from '../jobs.ts';
import { type RunningServer, startServer } from '../server.ts';
import type { ServiceRequest, VisionClient } from './client.ts';
import { registerVisionJobs } from './jobs.ts';
import type { CalibrationResult, FitResult, SegmentResult } from './types.ts';

const ONE_PIXEL_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

class ScriptedClient implements VisionClient {
  calibrateRequests: ServiceRequest[] = [];
  fitRequests: ServiceRequest[] = [];

  constructor(private readonly imageDir: string) {}

  async calibrate(request: ServiceRequest): Promise<CalibrationResult> {
    this.calibrateRequests.push(request);
    return {
      ok: true,
      method: 'two-point',
      mm_per_px: 1.5,
      core: { method: 'two-point', mmPerPx: 1.5 },
    };
  }

  async fit(request: ServiceRequest): Promise<FitResult> {
    this.fitRequests.push(request);
    return {
      instance: 1,
      fit: { glb: 'models/fit-001.glb' },
      dimensionsMm: { length_mm: 160 },
      confidence: 0.8,
      residual: 0.1,
      imageDir: this.imageDir,
    };
  }

  async segment(): Promise<SegmentResult> {
    throw new Error('not used');
  }
  async photoToWall(): Promise<never> {
    throw new Error('not used');
  }
  async photoToObjects(): Promise<never> {
    throw new Error('not used');
  }
  async status(): Promise<never> {
    throw new Error('not used');
  }
  async stop(): Promise<void> {}
}

const JobEnvelopeSchema = z.object({
  job: z.object({ state: z.string(), error: z.string().optional() }),
});
const UploadSchema = z.object({ photo: z.object({ id: z.string(), file: z.string() }) });

let root = '';
let running: RunningServer;
let client: ScriptedClient;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-vision-store-'));
  const imageDir = join(root, 'image-dir');
  mkdirSync(join(imageDir, 'models'), { recursive: true });
  writeFileSync(join(imageDir, 'models', 'fit-001.glb'), 'glb');
  client = new ScriptedClient(imageDir);
  const jobRegistry: JobRegistry = new Map();
  registerVisionJobs(
    {
      client,
      wallDir: (wallId) => join(root, 'home', 'walls', wallId),
      bankIndex: async () => null,
    },
    jobRegistry,
  );
  running = await startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home: join(root, 'home'),
      webDist: join(root, 'dist'),
      allowedOrigins: [],
      heartbeatMs: 1000,
    },
    { modules: [], jobRegistry },
  );
});

afterAll(async () => {
  await running.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a two-point calibration is recorded in the stored wall and the next fit of the photo uses that scale', async () => {
  const created = await fetch(`${running.url}/api/walls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'scaled', name: 'Scaled' }),
  });
  expect(created.status).toBe(201);
  const form = new FormData();
  form.set('file', new File([ONE_PIXEL_PNG], 'wall.png', { type: 'image/png' }));
  const upload = UploadSchema.parse(
    await (
      await fetch(`${running.url}/api/walls/scaled/photos`, { method: 'POST', body: form })
    ).json(),
  );
  expect(existsSync(join(root, 'home', 'walls', 'scaled', upload.photo.file))).toBe(true);

  const submit = async (kind: string, input: Record<string, unknown>): Promise<string> => {
    const response = await fetch(`${running.url}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind,
        wallId: 'scaled',
        input: { wallId: 'scaled', photoId: upload.photo.id, ...input },
      }),
    });
    expect(response.status).toBe(202);
    const id = z.object({ job: z.object({ id: z.string() }) }).parse(await response.json()).job.id;
    await (await fetch(`${running.url}/api/jobs/${id}/events`)).text(); // ends with the terminal state
    const finished = JobEnvelopeSchema.parse(
      await (await fetch(`${running.url}/api/jobs/${id}`)).json(),
    );
    expect(finished.job).toMatchObject({ state: 'succeeded' });
    return id;
  };

  await submit('vision.calibrate', {
    calibrate: {
      pointsPx: [
        [0, 0],
        [100, 0],
      ],
      distanceMm: 150,
    },
  });
  expect(client.calibrateRequests[0]).toMatchObject({
    calibrate: {
      points_px: [
        [0, 0],
        [100, 0],
      ],
      distance_mm: 150,
    },
  });
  expect(client.calibrateRequests[0]?.['image_path']).toBe(
    join(root, 'home', 'walls', 'scaled', upload.photo.file),
  );

  const { wall } = z
    .object({ wall: WallSchema })
    .parse(await (await fetch(`${running.url}/api/walls/scaled`)).json());
  expect(wall.photos[0]?.calibration).toEqual({ method: 'two-point', mmPerPx: 1.5 });
  const history = z
    .object({
      entries: z.array(z.looseObject({ actor: z.looseObject({ name: z.string().optional() }) })),
    })
    .parse(await (await fetch(`${running.url}/api/walls/scaled/history?since=0`)).json());
  expect(history.entries.at(-1)?.actor.name).toBe('vision');

  // no `calibrate` in the request: the fit takes the scale the wall's photo carries
  await submit('vision.fit', { instance: 1 });
  expect(client.fitRequests[0]?.['calibrate']).toEqual({ mm_per_px: 1.5 });
  // the fitted model is a real asset of the stored wall
  expect(existsSync(join(root, 'home', 'walls', 'scaled', 'models'))).toBe(true);
});
