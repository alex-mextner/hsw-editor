/** VisionClient against a fake sidecar served by Bun (TCP and unix socket) plus the lazy spawn / idle stop lifecycle. */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HttpVisionClient,
  type IdleScheduler,
  type SpawnFn,
  type SpawnedProcess,
} from './client.ts';
import type { StreamEvent } from './types.ts';
import { VisionError } from './types.ts';

let root = '';
const servers: { stop(force?: boolean): unknown }[] = [];
const hostHeaders: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hsw-vision-client-'));
  hostHeaders.length = 0;
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const RESULT = {
  status: 'ok',
  image: { sha256: 'a'.repeat(64), w: 10, h: 10 },
  calibration: { ok: true, method: 'two-point', mm_per_px: 1.5 },
  work: { imageDir: '/tmp/x' },
  proposal: {
    version: 1,
    photoId: null,
    autoApplyConfidence: null,
    items: [],
    holders: [],
    summary: {},
  },
  events: [],
  diagnostics: {},
};

function ndjson(lines: readonly string[], splitAt = 0): Response {
  const encoder = new TextEncoder();
  const text = lines.map((line) => `${line}\n`).join('');
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      if (splitAt > 0) {
        controller.enqueue(encoder.encode(text.slice(0, splitAt)));
        controller.enqueue(encoder.encode(text.slice(splitAt)));
      } else {
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
}

function sidecar(
  options: {
    unix?: string;
    photoToWall?: () => Response | Promise<Response>;
    photoToObjects?: () => Response | Promise<Response>;
  } = {},
) {
  const handler = (request: Request): Response | Promise<Response> => {
    const url = new URL(request.url);
    hostHeaders.push(request.headers.get('host') ?? '');
    if (url.pathname === '/health')
      return Response.json({ ok: true, name: 'hsw-vision', version: 'test' });
    if (url.pathname === '/models/status') return Response.json({ manager: { device: 'cpu' } });
    if (url.pathname === '/calibrate')
      return Response.json({ ok: true, method: 'grid', mm_per_px: 0.5 });
    if (url.pathname === '/segment') {
      return Response.json({
        image: { w: 1, h: 1, sha256: 'b'.repeat(64) },
        imageDir: '/tmp',
        dir: 'seg-1',
        instances: [],
      });
    }
    if (url.pathname === '/photo-to-wall') {
      return (
        options.photoToWall ?? (() => ndjson([JSON.stringify({ event: 'result', result: RESULT })]))
      )();
    }
    if (url.pathname === '/photo-to-objects' && options.photoToObjects !== undefined)
      return options.photoToObjects();
    if (url.pathname === '/missing') {
      return Response.json(
        {
          error: {
            code: 'models_missing',
            message: 'model sam2-tiny is missing',
            fix: 'hsw-editor vision fetch-models',
            details: { missing: ['sam2-tiny'] },
          },
        },
        { status: 424 },
      );
    }
    return new Response('nope', { status: 404 });
  };
  const server =
    options.unix === undefined
      ? Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
      : Bun.serve({ unix: options.unix, fetch: handler });
  servers.push(server);
  return server;
}

function tcpClient(server: ReturnType<typeof sidecar>): HttpVisionClient {
  return new HttpVisionClient({
    repoRoot: root,
    env: { HSW_VISION_URL: `http://127.0.0.1:${server.port}` },
    stateFile: join(root, 'state.json'),
  });
}

describe('requests', () => {
  test('stage calls return validated results over loopback TCP with a loopback Host header', async () => {
    const client = tcpClient(sidecar());
    expect((await client.calibrate({ image_path: '/x' })).method).toBe('grid');
    expect((await client.segment({ image_path: '/x' })).dir).toBe('seg-1');
    expect(hostHeaders.every((host) => host.startsWith('127.0.0.1:'))).toBe(true);
  });

  test('photoToObjects streams events and validates the per-object result', async () => {
    const objectsResult = {
      version: 1,
      status: 'no_scale',
      image: { sha256: 'a'.repeat(64), w: 10, h: 10 },
      outDir: '/tmp/out',
      calibration: { ok: false },
      summary: { found: 0 },
      objects: [],
      diagnostics: {},
    };
    const lines = [
      JSON.stringify({ event: 'stage', stage: 'segment', state: 'done' }),
      JSON.stringify({ event: 'result', result: objectsResult }),
    ];
    const client = tcpClient(sidecar({ photoToObjects: () => ndjson(lines) }));
    const seen: StreamEvent[] = [];
    const result = await client.photoToObjects({ image_path: '/x' }, (event) => seen.push(event));
    expect(result.status).toBe('no_scale');
    expect(result.outDir).toBe('/tmp/out');
    expect(seen).toHaveLength(1);

    const broken = tcpClient(
      sidecar({
        photoToObjects: () =>
          ndjson([JSON.stringify({ event: 'result', result: { ...objectsResult, outDir: 5 } })]),
      }),
    );
    await expect(broken.photoToObjects({}, () => {})).rejects.toThrow();
  });

  test('photoToWall delivers events in order (even split mid-line) and then the result', async () => {
    const lines = [
      JSON.stringify({ event: 'stage', stage: 'calibrate', state: 'start' }),
      JSON.stringify({ event: 'object', state: 'fitted', instanceId: 1, done: 1, total: 1 }),
      JSON.stringify({ type: 'request_view', reason: 'low_confidence', items: [] }),
      JSON.stringify({ event: 'result', result: RESULT }),
    ];
    const client = tcpClient(sidecar({ photoToWall: () => ndjson(lines, 37) }));
    const seen: StreamEvent[] = [];
    const result = await client.photoToWall({ image_path: '/x' }, (event) => seen.push(event));
    expect(seen.map((event) => event.event ?? event.type)).toEqual([
      'stage',
      'object',
      'request_view',
    ]);
    expect(result.status).toBe('ok');
    expect(result.calibration.mm_per_px).toBe(1.5);
  });

  test('an error event in the stream becomes a VisionError with its fix', async () => {
    const error = {
      code: 'models_missing',
      message: 'model sam2-tiny is missing',
      fix: 'hsw-editor vision fetch-models',
    };
    const client = tcpClient(
      sidecar({ photoToWall: () => ndjson([JSON.stringify({ event: 'error', error })]) }),
    );
    const failure = await client.photoToWall({}, () => {}).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(VisionError);
    expect(failure).toMatchObject({
      code: 'models_missing',
      fix: 'hsw-editor vision fetch-models',
    });
  });

  test('a stream that ends without a result is a protocol error', async () => {
    const client = tcpClient(
      sidecar({
        photoToWall: () =>
          ndjson([JSON.stringify({ event: 'stage', stage: 'open', state: 'done' })]),
      }),
    );
    await expect(client.photoToWall({}, () => {})).rejects.toMatchObject({
      code: 'vision_protocol',
    });
  });

  test('an HTTP error body is mapped to code, message, fix and details', async () => {
    const server = sidecar();
    const client = tcpClient(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/missing`);
    expect(response.status).toBe(424);
    // through the client: /calibrate on a sidecar that answers 424
    const failing = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === '/health'
          ? Response.json({ ok: true })
          : Response.json(
              {
                error: {
                  code: 'models_missing',
                  message: 'm',
                  fix: 'hsw-editor vision fetch-models',
                  details: { missing: ['sam2-tiny'] },
                },
              },
              { status: 424 },
            ),
    });
    servers.push(failing);
    const failure = await tcpClient(failing as unknown as ReturnType<typeof sidecar>)
      .calibrate({})
      .catch((caught: unknown) => caught);
    expect(failure).toMatchObject({
      code: 'models_missing',
      status: 424,
      fix: 'hsw-editor vision fetch-models',
      details: { missing: ['sam2-tiny'] },
    });
    expect(client).toBeDefined();
  });

  test('aborting the signal aborts the request', async () => {
    const never = Promise.withResolvers<Response>();
    const hang = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === '/health' ? Response.json({ ok: true }) : never.promise,
    });
    servers.push(hang);
    const controller = new AbortController();
    const pending = tcpClient(hang as unknown as ReturnType<typeof sidecar>).calibrate(
      {},
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });
});

describe('endpoint resolution and lifecycle', () => {
  test('a sidecar found through the state file on a unix socket is used without spawning', async () => {
    const socket = join(root, 'v.sock');
    sidecar({ unix: socket });
    writeFileSync(join(root, 'state.json'), JSON.stringify({ pid: process.pid, socket }));
    let spawned = 0;
    const client = new HttpVisionClient({
      repoRoot: root,
      env: {},
      stateFile: join(root, 'state.json'),
      spawn: () => (spawned++, failSpawn()),
    });
    expect((await client.calibrate({})).method).toBe('grid');
    expect(spawned).toBe(0);
    const status = await client.status();
    expect(status).toMatchObject({ running: true, managed: false, endpoint: `unix:${socket}` });
  });

  test('status never starts the sidecar', async () => {
    let spawned = 0;
    const client = new HttpVisionClient({
      repoRoot: root,
      env: {},
      stateFile: join(root, 'none.json'),
      spawn: () => (spawned++, failSpawn()),
    });
    expect(await client.status()).toEqual({
      running: false,
      managed: false,
      endpoint: null,
      health: null,
      models: null,
    });
    expect(spawned).toBe(0);
  });

  test('a stale state file (dead pid) is ignored', async () => {
    writeFileSync(
      join(root, 'state.json'),
      JSON.stringify({ pid: 2 ** 22 + 12345, url: 'http://127.0.0.1:1' }),
    );
    const client = new HttpVisionClient({
      repoRoot: root,
      env: {},
      stateFile: join(root, 'state.json'),
    });
    expect((await client.status()).running).toBe(false);
  });

  test('a missing venv is the structured vision_not_installed error naming the setup command', async () => {
    const client = new HttpVisionClient({
      repoRoot: root,
      env: {},
      venv: join(root, 'no-venv'),
      stateFile: join(root, 'state.json'),
    });
    const failure = await client.calibrate({}).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({ code: 'vision_not_installed' });
    expect((failure as VisionError).fix).toContain('hsw-editor vision setup');
  });

  test('HSW_VISION_URL that does not answer is an error, never a spawn', async () => {
    let spawned = 0;
    const client = new HttpVisionClient({
      repoRoot: root,
      env: { HSW_VISION_URL: 'http://127.0.0.1:9' },
      spawn: () => (spawned++, failSpawn()),
    });
    await expect(client.calibrate({})).rejects.toMatchObject({ code: 'vision_unreachable' });
    expect(spawned).toBe(0);
  });

  function failSpawn(): SpawnedProcess {
    throw new Error('spawn must not be called');
  }

  function venv(): string {
    const path = join(root, 'venv');
    mkdirSync(join(path, 'bin'), { recursive: true });
    writeFileSync(join(path, 'bin', 'python'), '');
    return path;
  }

  /** A fake `uv run ... hsw_vision serve`: serves on a unix socket and writes the state file like the real one. */
  function fakeSpawn(
    log: { argv: string[][]; kills: string[]; env: Record<string, string>[] },
    photoToWall?: () => Response | Promise<Response>,
  ): SpawnFn {
    return (request) => {
      log.argv.push([...request.argv]);
      log.env.push(request.env);
      const socket = join(root, `spawn-${log.argv.length}.sock`);
      const server = sidecar({
        unix: socket,
        ...(photoToWall === undefined ? {} : { photoToWall }),
      });
      const state = request.env['HSW_VISION_STATE'] as string;
      let exit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        exit = resolve;
      });
      writeFileSync(state, JSON.stringify({ pid: process.pid, socket }));
      return {
        pid: process.pid,
        exited,
        kill: (signal) => {
          log.kills.push(String(signal));
          void server.stop(true);
          exit(0);
        },
        stderrTail: () => '',
      };
    };
  }

  test('spawns lazily on the first request, once for concurrent requests, with uv run --no-sync and the venv', async () => {
    const log = {
      argv: [] as string[][],
      kills: [] as string[],
      env: [] as Record<string, string>[],
    };
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: { HOME: '/h' },
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn: fakeSpawn(log),
      idleStopMs: 60_000,
    });
    expect(log.argv).toHaveLength(0);
    const results = await Promise.all([
      client.calibrate({}),
      client.calibrate({}),
      client.segment({}),
    ]);
    expect(results).toHaveLength(3);
    expect(log.argv).toHaveLength(1);
    expect(log.argv[0]).toEqual([
      'uv',
      'run',
      '--no-sync',
      '--project',
      '/repo/services/vision',
      'python',
      '-m',
      'hsw_vision',
      'serve',
    ]);
    expect(log.env[0]?.['UV_PROJECT_ENVIRONMENT']).toBe(join(root, 'venv'));
    expect(log.env[0]?.['HSW_VISION_STATE']).toBe(join(root, 'state.json'));
    expect((await client.status()).managed).toBe(true);
    await client.stop();
    expect(log.kills).toEqual(['SIGTERM']);
  });

  /** Idle timer driven by hand: `fire()` is "the idle period elapsed". */
  class ManualScheduler implements IdleScheduler {
    callbacks: (() => void)[] = [];
    cancelled = 0;
    start(fn: () => void): unknown {
      this.callbacks.push(fn);
      return fn;
    }
    cancel(): void {
      this.cancelled++;
    }
    fire(): void {
      this.callbacks.pop()?.();
    }
  }

  test('stops the sidecar it spawned when the idle period elapses and starts it again on demand', async () => {
    const log = {
      argv: [] as string[][],
      kills: [] as string[],
      env: [] as Record<string, string>[],
    };
    const scheduler = new ManualScheduler();
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn: fakeSpawn(log),
      scheduler,
    });
    await client.calibrate({});
    expect(log.kills).toEqual([]);
    expect(scheduler.callbacks).toHaveLength(1);
    scheduler.fire();
    await client.stop(); // the fired callback already stopped it; stopping again is a no-op
    expect(log.kills).toEqual(['SIGTERM']);
    await client.calibrate({});
    expect(log.argv).toHaveLength(2);
    await client.stop();
  });

  test('the idle timer is not armed while a request is in flight', async () => {
    const log = {
      argv: [] as string[][],
      kills: [] as string[],
      env: [] as Record<string, string>[],
    };
    const scheduler = new ManualScheduler();
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const spawn = fakeSpawn(log, async () => {
      started.resolve();
      await gate.promise;
      return ndjson([JSON.stringify({ event: 'result', result: RESULT })]);
    });
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn,
      scheduler,
    });
    const pending = client.photoToWall({}, () => {});
    await started.promise;
    expect(scheduler.callbacks).toHaveLength(0); // running: no idle timer
    gate.resolve();
    await pending;
    expect(scheduler.callbacks).toHaveLength(1); // finished: armed
    await client.stop();
  });

  /** `fakeSpawn` that also hands out the processes it started, so a test can kill one the way the OS would. */
  function trackedSpawn(log: {
    argv: string[][];
    kills: string[];
    env: Record<string, string>[];
  }): {
    spawn: SpawnFn;
    processes: SpawnedProcess[];
  } {
    const base = fakeSpawn(log);
    const processes: SpawnedProcess[] = [];
    return {
      processes,
      spawn: (request) => {
        const started = base(request);
        processes.push(started);
        return started;
      },
    };
  }

  test('respawns on the next request after the sidecar it started has died', async () => {
    const log = {
      argv: [] as string[][],
      kills: [] as string[],
      env: [] as Record<string, string>[],
    };
    const { spawn, processes } = trackedSpawn(log);
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn,
      scheduler: new ManualScheduler(),
    });
    expect((await client.calibrate({})).method).toBe('grid');
    processes[0]?.kill('SIGKILL'); // killed from outside: the server is gone and `exited` resolves
    await processes[0]?.exited;
    expect((await client.status()).running).toBe(false);
    expect((await client.calibrate({})).method).toBe('grid');
    expect(log.argv).toHaveLength(2);
    expect((await client.status()).managed).toBe(true);
    await client.stop();
  });

  test('a request that finds the connection dead before `exited` fired starts a new sidecar, kills the old one and retries once', async () => {
    const log = {
      argv: [] as string[][],
      kills: [] as string[],
      env: [] as Record<string, string>[],
    };
    const { spawn } = trackedSpawn(log);
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn,
      scheduler: new ManualScheduler(),
    });
    await client.calibrate({});
    // the HTTP server dies but the process has not been reaped yet (no `exited`): the cached endpoint is stale
    await servers[0]?.stop(true);
    expect((await client.calibrate({})).method).toBe('grid');
    expect(log.argv).toHaveLength(2);
    expect(log.kills).toEqual(['SIGTERM']); // the unresponsive first sidecar does not keep running next to the new one
    await client.stop();
    expect(log.kills).toEqual(['SIGTERM', 'SIGTERM']);
  });

  test('an explicit stop() fails the request in flight with vision_stopped and does not respawn for it', async () => {
    const log = {
      argv: [] as string[][],
      kills: [] as string[],
      env: [] as Record<string, string>[],
    };
    const started = Promise.withResolvers<void>();
    const never = Promise.withResolvers<Response>();
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn: fakeSpawn(log, () => {
        started.resolve();
        return never.promise;
      }),
      scheduler: new ManualScheduler(),
    });
    const pending = client.photoToWall({}, () => {}).catch((caught: unknown) => caught);
    await started.promise;
    await client.stop();
    expect(await pending).toMatchObject({ code: 'vision_stopped' });
    expect(log.argv).toHaveLength(1);
  });

  test('an explicit stop() while the sidecar is still starting is vision_stopped, not a start failure', async () => {
    const spawned = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    const spawn: SpawnFn = () => {
      spawned.resolve();
      return {
        pid: 1,
        exited: exited.promise,
        kill: () => exited.resolve(0),
        stderrTail: () => '',
      }; // never writes the state file: still "starting"
    };
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn,
      scheduler: new ManualScheduler(),
      startTimeoutMs: 10_000,
    });
    const pending = client.calibrate({}).catch((caught: unknown) => caught);
    await spawned.promise;
    await client.stop();
    expect(await pending).toMatchObject({ code: 'vision_stopped' });
  });

  test('a request made right after stop() does not join the start that stop() doomed', async () => {
    const log = {
      argv: [] as string[][],
      kills: [] as string[],
      env: [] as Record<string, string>[],
    };
    const working = fakeSpawn(log);
    const firstSpawned = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    let spawns = 0;
    const spawn: SpawnFn = (request) => {
      spawns++;
      if (spawns > 1) return working(request);
      firstSpawned.resolve();
      return {
        pid: 1,
        exited: exited.promise,
        kill: () => exited.resolve(0),
        stderrTail: () => '',
      };
    };
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn,
      scheduler: new ManualScheduler(),
      startTimeoutMs: 10_000,
    });
    const first = client.calibrate({}).catch((caught: unknown) => caught);
    await firstSpawned.promise;
    const stopping = client.stop();
    const second = client.calibrate({});
    await stopping;
    expect(await first).toMatchObject({ code: 'vision_stopped' });
    expect((await second).method).toBe('grid');
    await client.stop();
  });

  test('a sidecar that dies while starting is reported with its stderr tail', async () => {
    const spawn: SpawnFn = () => ({
      pid: 1,
      exited: Promise.resolve(3),
      kill: () => {},
      stderrTail: () => 'ModuleNotFoundError: torch',
    });
    const client = new HttpVisionClient({
      repoRoot: '/repo',
      env: {},
      venv: venv(),
      stateFile: join(root, 'state.json'),
      spawn,
      startTimeoutMs: 3000,
    });
    const failure = await client.calibrate({}).catch((caught: unknown) => caught);
    expect(failure).toMatchObject({
      code: 'vision_start_failed',
      details: 'ModuleNotFoundError: torch',
    });
  });
});
