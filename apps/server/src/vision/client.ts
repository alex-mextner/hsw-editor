/**
 * VisionClient: the Bun side of the vision sidecar.
 *
 * Endpoint resolution (first hit wins): `HSW_VISION_URL` (an externally managed sidecar, never spawned or stopped
 * by us), the sidecar's state file (`~/.cache/hsw-editor/vision/state.json`: written by `python -m hsw_vision serve`
 * with the loopback port it actually got, or its unix socket), otherwise the client spawns the sidecar lazily on the
 * first request and stops it again after `idleStopMs` without requests so the GPU is free for other work.
 * Spawning never installs anything (`uv run --no-sync`): a missing venv is the structured error `vision_not_installed`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { JsonValue } from '@hsw-editor/core';
import { z } from 'zod';
import {
  type CalibrationResult,
  CalibrationResultSchema,
  type FitResult,
  FitResultSchema,
  type PhotoToObjectsResult,
  PhotoToObjectsResultSchema,
  type PhotoToWallResult,
  PhotoToWallResultSchema,
  type SegmentResult,
  SegmentResultSchema,
  ServiceErrorBodySchema,
  type StreamEvent,
  StreamEventSchema,
  VisionError,
} from './types.ts';

export type ServiceRequest = Record<string, JsonValue>;

export interface VisionStatus {
  running: boolean;
  /** True when this server spawned the sidecar (and will stop it when idle). */
  managed: boolean;
  endpoint: string | null;
  health: JsonValue | null;
  /** `GET /models/status` of the sidecar; only fetched when it is already running. */
  models: JsonValue | null;
}

/** What the job handlers use; tests implement it with a fake. */
export interface VisionClient {
  calibrate(request: ServiceRequest, signal?: AbortSignal): Promise<CalibrationResult>;
  segment(request: ServiceRequest, signal?: AbortSignal): Promise<SegmentResult>;
  fit(request: ServiceRequest, signal?: AbortSignal): Promise<FitResult>;
  photoToWall(
    request: ServiceRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<PhotoToWallResult>;
  photoToObjects(
    request: ServiceRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<PhotoToObjectsResult>;
  status(): Promise<VisionStatus>;
  stop(): Promise<void>;
}

export type Endpoint = { kind: 'tcp'; base: string } | { kind: 'unix'; socket: string };

const StateFileSchema = z.object({
  pid: z.number().int(),
  url: z.string().optional(),
  socket: z.string().optional(),
});

export interface SpawnedProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
  stderrTail(): string;
}

export interface SpawnRequest {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly cwd: string;
}
export type SpawnFn = (request: SpawnRequest) => SpawnedProcess;

export interface HttpVisionClientOptions {
  /** Repository root (contains `services/vision`). */
  repoRoot: string;
  env?: Record<string, string | undefined>;
  stateFile?: string;
  venv?: string;
  idleStopMs?: number;
  startTimeoutMs?: number;
  spawn?: SpawnFn;
  /** Schedules the idle stop; tests inject a manual one. */
  scheduler?: IdleScheduler;
}

/** Starts a one-shot timer (`ms`) and returns a handle for `cancel`. */
export interface IdleScheduler {
  start(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

const timerScheduler: IdleScheduler = {
  start(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const DEFAULT_IDLE_STOP_MS = 10 * 60_000;
const DEFAULT_START_TIMEOUT_MS = 120_000;

export function defaultStateFile(env: Record<string, string | undefined>): string {
  return (
    env['HSW_VISION_STATE'] ??
    join(env['HSW_EDITOR_CACHE'] ?? join(homedir(), '.cache', 'hsw-editor'), 'vision', 'state.json')
  );
}

export function defaultVenv(env: Record<string, string | undefined>): string {
  return (
    env['UV_PROJECT_ENVIRONMENT'] ??
    join(env['HSW_EDITOR_CACHE'] ?? join(homedir(), '.cache', 'hsw-editor'), 'vision-venv')
  );
}

function spawnWithBun(request: SpawnRequest): SpawnedProcess {
  const proc = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  let tail = '';
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) tail = (tail + decoder.decode(chunk)).slice(-4000);
  })();
  return {
    pid: proc.pid,
    exited: proc.exited,
    kill: (signal) => proc.kill(signal),
    stderrTail: () => tail,
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class HttpVisionClient implements VisionClient {
  private readonly env: Record<string, string | undefined>;
  private readonly stateFile: string;
  private readonly venv: string;
  private readonly idleStopMs: number;
  private readonly startTimeoutMs: number;
  private readonly spawn: SpawnFn;
  private endpoint: Endpoint | undefined;
  private child: SpawnedProcess | undefined;
  private starting: Promise<Endpoint> | undefined;
  private inFlight = 0;
  private idleHandle: unknown;
  private readonly scheduler: IdleScheduler;

  constructor(private readonly options: HttpVisionClientOptions) {
    this.env = options.env ?? process.env;
    this.stateFile = options.stateFile ?? defaultStateFile(this.env);
    this.venv = options.venv ?? defaultVenv(this.env);
    this.idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    this.scheduler = options.scheduler ?? timerScheduler;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.spawn = options.spawn ?? spawnWithBun;
  }

  // ---- public API ----------------------------------------------------------------------------------

  async calibrate(request: ServiceRequest, signal?: AbortSignal): Promise<CalibrationResult> {
    return CalibrationResultSchema.parse(await this.postJson('/calibrate', request, signal));
  }

  async segment(request: ServiceRequest, signal?: AbortSignal): Promise<SegmentResult> {
    return SegmentResultSchema.parse(await this.postJson('/segment', request, signal));
  }

  async fit(request: ServiceRequest, signal?: AbortSignal): Promise<FitResult> {
    return FitResultSchema.parse(await this.postJson('/fit', request, signal));
  }

  async photoToWall(
    request: ServiceRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<PhotoToWallResult> {
    return this.stream('/photo-to-wall', request, PhotoToWallResultSchema, onEvent, signal);
  }

  async photoToObjects(
    request: ServiceRequest,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<PhotoToObjectsResult> {
    return this.stream('/photo-to-objects', request, PhotoToObjectsResultSchema, onEvent, signal);
  }

  /** POST `request`, forward the NDJSON progress events and return the validated final `result` line. */
  private async stream<T>(
    path: string,
    request: ServiceRequest,
    schema: z.ZodType<T>,
    onEvent: (event: StreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.track(async () => {
      const response = await this.send(path, { method: 'POST', body: request }, signal);
      if (response.body === null) throw new VisionError('vision_protocol', 'empty stream');
      let result: T | undefined;
      for await (const line of readLines(response.body)) {
        const parsed: unknown = JSON.parse(line);
        const event = StreamEventSchema.parse(parsed);
        if (event.event === 'result') {
          result = schema.parse(z.looseObject({ result: z.unknown() }).parse(parsed).result);
        } else if (event.event === 'error') {
          throw errorFromBody(parsed, response.status);
        } else {
          onEvent(event);
        }
      }
      if (result === undefined) {
        throw new VisionError('vision_protocol', 'the stream ended without a result', {
          fix: 'the sidecar stopped mid-run; check `hsw-editor vision doctor` and retry',
        });
      }
      return result;
    });
  }

  async status(): Promise<VisionStatus> {
    const endpoint = await this.lookup();
    if (endpoint === undefined) {
      return { running: false, managed: false, endpoint: null, health: null, models: null };
    }
    const health = await this.tryGet(endpoint, '/health');
    const models = health === null ? null : await this.tryGet(endpoint, '/models/status');
    return {
      running: health !== null,
      managed: this.child !== undefined,
      endpoint: endpoint.kind === 'tcp' ? endpoint.base : `unix:${endpoint.socket}`,
      health,
      models,
    };
  }

  async stop(): Promise<void> {
    this.clearIdle();
    const child = this.child;
    this.child = undefined;
    this.endpoint = undefined;
    if (child === undefined) return;
    child.kill('SIGTERM');
    const exited = await Promise.race([
      child.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) child.kill('SIGKILL');
  }

  // ---- transport -----------------------------------------------------------------------------------

  private async postJson(
    path: string,
    body: ServiceRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.track(async () => {
      const response = await this.send(path, { method: 'POST', body }, signal);
      return (await response.json()) as unknown;
    });
  }

  /** Holds the idle timer off while a request runs, restarts it afterwards. */
  private async track<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight++;
    this.clearIdle();
    try {
      return await work();
    } finally {
      this.inFlight--;
      this.armIdle();
    }
  }

  private async send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: ServiceRequest },
    signal?: AbortSignal,
  ): Promise<Response> {
    const endpoint = await this.ensure();
    let response: Response;
    try {
      response = await this.fetchEndpoint(endpoint, path, init, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // The sidecar may have died (or been stopped by a previous idle timer): forget it, start once more.
      this.endpoint = undefined;
      const fresh = await this.ensure();
      response = await this.fetchEndpoint(fresh, path, init, signal);
    }
    if (!response.ok) throw errorFromBody(await response.json().catch(() => null), response.status);
    return response;
  }

  private fetchEndpoint(
    endpoint: Endpoint,
    path: string,
    init: { method: 'GET' | 'POST'; body?: ServiceRequest },
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = endpoint.kind === 'tcp' ? `${endpoint.base}${path}` : `http://localhost${path}`;
    return fetch(url, {
      method: init.method,
      ...(init.body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }),
      ...(signal === undefined ? {} : { signal }),
      ...(endpoint.kind === 'unix' ? { unix: endpoint.socket } : {}),
    });
  }

  private async tryGet(endpoint: Endpoint, path: string): Promise<JsonValue | null> {
    try {
      const response = await this.fetchEndpoint(
        endpoint,
        path,
        { method: 'GET' },
        AbortSignal.timeout(3000),
      );
      if (!response.ok) return null;
      return z.json().parse(await response.json());
    } catch {
      return null;
    }
  }

  // ---- lifecycle -----------------------------------------------------------------------------------

  /** An already running sidecar (env or state file), without starting one. */
  private async lookup(): Promise<Endpoint | undefined> {
    if (this.endpoint !== undefined) return this.endpoint;
    const url = this.env['HSW_VISION_URL'];
    if (url !== undefined && url !== '') return { kind: 'tcp', base: url.replace(/\/$/, '') };
    const state = await this.readState();
    if (state === undefined || !pidAlive(state.pid)) return undefined;
    if (state.socket !== undefined) return { kind: 'unix', socket: state.socket };
    return state.url === undefined ? undefined : { kind: 'tcp', base: state.url };
  }

  private async readState(): Promise<z.infer<typeof StateFileSchema> | undefined> {
    try {
      return StateFileSchema.parse(JSON.parse(await readFile(this.stateFile, 'utf8')));
    } catch {
      return undefined;
    }
  }

  private async ensure(): Promise<Endpoint> {
    if (this.endpoint !== undefined) return this.endpoint;
    if (this.starting !== undefined) return this.starting;
    this.starting = this.resolveOrStart().finally(() => {
      this.starting = undefined;
    });
    this.endpoint = await this.starting;
    return this.endpoint;
  }

  private async resolveOrStart(): Promise<Endpoint> {
    const existing = await this.lookup();
    if (existing !== undefined && (await this.tryGet(existing, '/health')) !== null)
      return existing;
    if (this.env['HSW_VISION_URL'] !== undefined && this.env['HSW_VISION_URL'] !== '') {
      throw new VisionError(
        'vision_unreachable',
        `no vision sidecar answers at ${this.env['HSW_VISION_URL']}`,
        {
          fix: 'start it (`python -m hsw_vision serve`) or unset HSW_VISION_URL to let hsw-editor manage it',
        },
      );
    }
    return this.start();
  }

  private async start(): Promise<Endpoint> {
    const project = join(this.options.repoRoot, 'services', 'vision');
    if (!existsSync(join(this.venv, 'bin', 'python'))) {
      throw new VisionError(
        'vision_not_installed',
        `the vision environment ${this.venv} does not exist`,
        {
          fix: `hsw-editor vision setup  (creates ${this.venv}: heavy torch/CUDA install; see docs/vision.md)`,
        },
      );
    }
    await mkdir(dirname(this.stateFile), { recursive: true });
    await rm(this.stateFile, { force: true });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.env)) if (value !== undefined) env[key] = value;
    env['UV_PROJECT_ENVIRONMENT'] = this.venv;
    env['HSW_VISION_STATE'] = this.stateFile;
    const child = this.spawn({
      argv: ['uv', 'run', '--no-sync', '--project', project, 'python', '-m', 'hsw_vision', 'serve'],
      env,
      cwd: project,
    });
    this.child = child;
    let exitCode: number | undefined;
    void child.exited.then((code) => {
      exitCode = code;
      if (this.child === child) {
        this.child = undefined;
        this.endpoint = undefined;
      }
    });
    const deadline = Date.now() + this.startTimeoutMs;
    while (Date.now() < deadline) {
      if (exitCode !== undefined) {
        throw new VisionError(
          'vision_start_failed',
          `the vision sidecar exited with code ${exitCode}`,
          {
            fix: 'run `hsw-editor vision doctor`',
            details: child.stderrTail(),
          },
        );
      }
      const state = await this.readState();
      if (state !== undefined) {
        const endpoint: Endpoint =
          state.socket !== undefined
            ? { kind: 'unix', socket: state.socket }
            : { kind: 'tcp', base: state.url ?? '' };
        if ((await this.tryGet(endpoint, '/health')) !== null) return endpoint;
      }
      await Bun.sleep(150);
    }
    await this.stop();
    throw new VisionError(
      'vision_start_timeout',
      `the vision sidecar did not become healthy in ${this.startTimeoutMs} ms`,
      {
        fix: 'run `hsw-editor vision doctor`',
      },
    );
  }

  private armIdle(): void {
    this.clearIdle();
    if (this.child === undefined || this.inFlight > 0) return;
    this.idleHandle = this.scheduler.start(() => {
      void this.stop();
    }, this.idleStopMs);
  }

  private clearIdle(): void {
    if (this.idleHandle === undefined) return;
    this.scheduler.cancel(this.idleHandle);
    this.idleHandle = undefined;
  }
}

function errorFromBody(body: unknown, status: number): VisionError {
  const parsed = ServiceErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return new VisionError('vision_http', `the vision sidecar answered HTTP ${status}`, { status });
  }
  const { code, message, fix, details } = parsed.data.error;
  return new VisionError(code, message, {
    status,
    ...(fix === undefined ? {} : { fix }),
    ...(details === undefined ? {} : { details }),
  });
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== '') yield line;
      newline = buffer.indexOf('\n');
    }
  }
  const rest = buffer.trim();
  if (rest !== '') yield rest;
}
