/**
 * `/api/vision/status` and `/api/vision/stop` through the real request pipeline (`startServer` -> `createHandler`: loopback
 * guard, modules, core API), with a vision job in flight on a sidecar stand-in that the client spawned.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { type JobRegistry } from '../jobs.ts';
import { type RunningServer, startServer } from '../server.ts';
import { HttpVisionClient, type SpawnFn } from './client.ts';
import { registerVisionJobs } from './jobs.ts';
import { createVisionModule } from './routes.ts';

const OBJECTS_RESULT = {
  version: 1,
  status: 'no_scale',
  image: { sha256: 'a'.repeat(64), w: 10, h: 10 },
  outDir: '/tmp/out',
  calibration: { ok: false },
  summary: { found: 0 },
  objects: [],
  diagnostics: {},
};

const JobEnvelopeSchema = z.object({
  job: z.object({
    id: z.string(),
    state: z.string(),
    error: z.string().optional(),
    result: z.looseObject({ status: z.string() }).optional(),
  }),
});
type Job = z.infer<typeof JobEnvelopeSchema>['job'];

let root = '';
let running: RunningServer;
let client: HttpVisionClient;
let photo = '';
const servers: { stop(force?: boolean): unknown }[] = [];
let spawned = 0;
let gate = Promise.withResolvers<void>();
let jobRunning = Promise.withResolvers<void>();
/** `true`: the next /photo-to-objects blocks until the sidecar is killed. */
let blockNext = false;

function sidecarSpawn(): SpawnFn {
  return (request) => {
    spawned++;
    const socket = join(root, `sidecar-${spawned}.sock`);
    const server = Bun.serve({
      unix: socket,
      async fetch(incoming) {
        const { pathname } = new URL(incoming.url);
        if (pathname === '/health') return Response.json({ ok: true, name: 'hsw-vision' });
        if (pathname === '/models/status') return Response.json({ manager: { device: 'cpu' } });
        if (pathname === '/photo-to-objects') {
          if (blockNext) {
            blockNext = false;
            jobRunning.resolve();
            await gate.promise; // never resolved: the kill below ends the connection
          }
          return new Response(`${JSON.stringify({ event: 'result', result: OBJECTS_RESULT })}\n`);
        }
        return new Response('nope', { status: 404 });
      },
    });
    servers.push(server);
    const state = request.env['HSW_VISION_STATE'] as string;
    writeFileSync(state, JSON.stringify({ pid: process.pid, socket }));
    const exited = Promise.withResolvers<number>();
    return {
      pid: process.pid,
      exited: exited.promise,
      kill: () => {
        void server.stop(true);
        exited.resolve(0);
      },
      stderrTail: () => '',
    };
  };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-vision-routes-'));
  spawned = 0;
  blockNext = false;
  gate = Promise.withResolvers<void>();
  jobRunning = Promise.withResolvers<void>();
  photo = join(root, 'photo.jpg');
  writeFileSync(photo, 'jpeg');
  const venv = join(root, 'venv');
  await Bun.write(join(venv, 'bin', 'python'), '');
  client = new HttpVisionClient({
    repoRoot: root,
    env: {},
    venv,
    stateFile: join(root, 'state.json'),
    spawn: sidecarSpawn(),
    startTimeoutMs: 5000,
  });
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
    { modules: [createVisionModule(client)], jobRegistry },
  );
});

afterEach(async () => {
  await running.stop();
  await client.stop();
  for (const server of servers.splice(0)) await server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function submit(): Promise<string> {
  const response = await fetch(`${running.url}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'vision.photo_to_objects', input: { imagePath: photo } }),
  });
  expect(response.status).toBe(202);
  return JobEnvelopeSchema.parse(await response.json()).job.id;
}

/** The job's event stream ends with its terminal state: reading it to the end waits for the job without polling. */
async function finished(id: string): Promise<Job> {
  await (await fetch(`${running.url}/api/jobs/${id}/events`)).text();
  return JobEnvelopeSchema.parse(await (await fetch(`${running.url}/api/jobs/${id}`)).json()).job;
}

describe('/api/vision routes through the request pipeline', () => {
  test('status never starts the sidecar and reports a stopped one', async () => {
    const response = await fetch(`${running.url}/api/vision/status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ running: false, managed: false, endpoint: null });
    expect(spawned).toBe(0);
  });

  test('other methods and paths fall through to the core API (404), they are not claimed by the module', async () => {
    expect((await fetch(`${running.url}/api/vision/stop`)).status).toBe(404);
    expect((await fetch(`${running.url}/api/vision/nope`)).status).toBe(404);
  });

  test('the loopback guard in front of the modules rejects a foreign origin', async () => {
    const response = await fetch(`${running.url}/api/vision/stop`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    expect(spawned).toBe(0);
  });

  test('POST /api/vision/stop during a job fails that job with the remedy, and the next job starts a new sidecar', async () => {
    blockNext = true;
    const first = await submit();
    await jobRunning.promise; // the sidecar is spawned and holds the request
    expect(spawned).toBe(1);
    expect(await (await fetch(`${running.url}/api/vision/status`)).json()).toMatchObject({
      running: true,
      managed: true,
    });

    const stop = await fetch(`${running.url}/api/vision/stop`, { method: 'POST' });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true });

    const failed = await finished(first);
    expect(failed.state).toBe('failed');
    expect(failed.error ?? '').toContain('stopped');
    expect(await (await fetch(`${running.url}/api/vision/status`)).json()).toMatchObject({
      running: false,
      managed: false,
    });

    // the freed GPU is claimed again by the next job: a second sidecar, a normal result
    const second = await finished(await submit());
    expect(second.state).toBe('succeeded');
    expect(second.result?.status).toBe('no_scale');
    expect(spawned).toBe(2);
  });
});
