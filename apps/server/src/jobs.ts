/**
 * Generic job runner for long tasks (vision, drawing). Other modules register a handler once with
 * `registerJob` (at import time); clients submit through `POST /api/jobs` and follow progress over SSE.
 *
 *   registerJob({
 *     kind: 'draw.views',
 *     inputSchema: z.object({ wallId: IdSchema, ... }),
 *     async run(input, ctx) { ctx.progress({ done: 1, total: 4, message: 'side view' }); return { ... }; },
 *   });
 */
import {
  type Actor,
  type InputRequest,
  type JsonValue,
  type NewInputRequest,
  formatIssues,
} from '@hsw-editor/core';
import type { z } from 'zod';
import type { ApplyRequest, AssetSlot, Outcome, WallState } from './store/wall-store.ts';

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobProgress {
  done?: number;
  total?: number;
  fraction?: number;
  message?: string;
  data?: JsonValue;
}

export interface Job {
  id: string;
  kind: string;
  wallId?: string;
  state: JobState;
  progress?: JobProgress;
  result?: JsonValue;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** The slice of the wall store a job may use: ops and assets go through the single writer. */
export interface JobWalls {
  get(wallId: string): Promise<WallState>;
  apply(wallId: string, request: ApplyRequest): Promise<Outcome>;
  addAsset(wallId: string, slot: AssetSlot): Promise<string>;
  /**
   * Opens an input request (the UI renders a widget) and resolves with it once answered or cancelled.
   * Aborting `signal` cancels the question.
   */
  askUser(
    wallId: string,
    request: NewInputRequest,
    actor: Actor,
    signal: AbortSignal,
  ): Promise<InputRequest>;
}

export interface JobContext {
  readonly id: string;
  readonly kind: string;
  readonly wallId: string | undefined;
  /** Aborted when the job is cancelled; handlers must stop promptly. */
  readonly signal: AbortSignal;
  progress(update: JobProgress): void;
  log(message: string): void;
  readonly walls: JobWalls;
}

export interface JobHandler<I> {
  readonly kind: string;
  readonly inputSchema: z.ZodType<I>;
  /** Max simultaneous runs of this kind (default 1: jobs are usually GPU/CPU heavy). */
  readonly concurrency?: number;
  run(input: I, ctx: JobContext): Promise<JsonValue>;
}

interface RegisteredJob {
  readonly kind: string;
  readonly concurrency: number;
  parse(
    raw: JsonValue,
  ): { ok: true; run: (ctx: JobContext) => Promise<JsonValue> } | { ok: false; issues: string[] };
}

export type JobRegistry = Map<string, RegisteredJob>;

/** Default registry that `registerJob` fills; the daemon's runner reads it. */
export const defaultJobRegistry: JobRegistry = new Map();

export function registerJob<I>(
  handler: JobHandler<I>,
  registry: JobRegistry = defaultJobRegistry,
): void {
  if (registry.has(handler.kind)) throw new Error(`job kind ${handler.kind} is already registered`);
  registry.set(handler.kind, {
    kind: handler.kind,
    concurrency: handler.concurrency ?? 1,
    parse(raw) {
      const parsed = handler.inputSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
      const input = parsed.data;
      return { ok: true, run: (ctx) => handler.run(input, ctx) };
    },
  });
}

export class JobError extends Error {
  readonly code: 'unknown_job_kind' | 'invalid_input' | 'job_not_found';
  readonly issues: readonly string[];
  constructor(code: JobError['code'], message: string, issues: readonly string[] = []) {
    super(message);
    this.name = 'JobError';
    this.code = code;
    this.issues = issues;
  }
}

export interface JobEvent {
  id: number;
  event: 'state' | 'progress' | 'log';
  data: JsonValue;
}

export interface JobListener {
  onEvent(event: JobEvent): void;
  onEnd(): void;
}

interface JobRecord {
  job: Job;
  run: (ctx: JobContext) => Promise<JsonValue>;
  concurrencyKey: string;
  controller: AbortController;
  events: JobEvent[];
  listeners: Set<JobListener>;
}

const MAX_EVENTS = 1000;
const MAX_FINISHED = 200;
const TERMINAL: ReadonlySet<JobState> = new Set(['succeeded', 'failed', 'cancelled']);

export class JobRunner {
  private readonly records = new Map<string, JobRecord>();
  private readonly running = new Map<string, number>();
  private nextId = 1;

  constructor(
    private readonly registry: JobRegistry,
    private readonly walls: JobWalls,
    private readonly now: () => Date = () => new Date(),
  ) {}

  kinds(): string[] {
    return [...this.registry.keys()];
  }

  submit(kind: string, input: JsonValue, wallId?: string): Job {
    const registered = this.registry.get(kind);
    if (registered === undefined)
      throw new JobError('unknown_job_kind', `no job handler for kind ${kind}`);
    const parsed = registered.parse(input);
    if (!parsed.ok) throw new JobError('invalid_input', `invalid input for ${kind}`, parsed.issues);
    const id = `j${this.nextId++}-${Math.random().toString(36).slice(2, 8)}`;
    const job: Job = {
      id,
      kind,
      ...(wallId === undefined ? {} : { wallId }),
      state: 'queued',
      createdAt: this.now().toISOString(),
    };
    const record: JobRecord = {
      job,
      run: parsed.run,
      concurrencyKey: kind,
      controller: new AbortController(),
      events: [],
      listeners: new Set(),
    };
    this.records.set(id, record);
    this.emit(record, 'state', { state: 'queued' });
    this.pump(kind);
    this.prune();
    return { ...job };
  }

  get(id: string): Job {
    return { ...this.record(id).job };
  }

  list(
    filter: {
      kind?: string | undefined;
      wallId?: string | undefined;
      state?: string | undefined;
    } = {},
  ): Job[] {
    return [...this.records.values()]
      .map((record) => record.job)
      .filter(
        (job) =>
          (filter.kind === undefined || job.kind === filter.kind) &&
          (filter.wallId === undefined || job.wallId === filter.wallId) &&
          (filter.state === undefined || job.state === filter.state),
      )
      .map((job) => ({ ...job }))
      .reverse();
  }

  cancel(id: string): Job {
    const record = this.record(id);
    if (TERMINAL.has(record.job.state)) return { ...record.job };
    record.controller.abort();
    this.finish(record, 'cancelled', {});
    return { ...record.job };
  }

  /** Replays events after `lastEventId`, then streams live ones. Ends immediately for finished jobs. */
  subscribe(id: string, lastEventId: number, listener: JobListener): () => void {
    const record = this.record(id);
    for (const event of record.events) if (event.id > lastEventId) listener.onEvent(event);
    if (TERMINAL.has(record.job.state)) {
      listener.onEnd();
      return () => undefined;
    }
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  private record(id: string): JobRecord {
    const record = this.records.get(id);
    if (record === undefined) throw new JobError('job_not_found', `job ${id} does not exist`);
    return record;
  }

  private pump(kind: string): void {
    const limit = this.registry.get(kind)?.concurrency ?? 1;
    for (const record of this.records.values()) {
      if ((this.running.get(kind) ?? 0) >= limit) return;
      if (record.job.kind === kind && record.job.state === 'queued') void this.start(record);
    }
  }

  private async start(record: JobRecord): Promise<void> {
    const { job } = record;
    this.running.set(job.kind, (this.running.get(job.kind) ?? 0) + 1);
    job.state = 'running';
    job.startedAt = this.now().toISOString();
    this.emit(record, 'state', { state: 'running' });
    const context: JobContext = {
      id: job.id,
      kind: job.kind,
      wallId: job.wallId,
      signal: record.controller.signal,
      walls: this.walls,
      progress: (update) => {
        if (TERMINAL.has(job.state)) return;
        job.progress = update;
        this.emit(record, 'progress', { ...update });
      },
      log: (message) => this.emit(record, 'log', { message }),
    };
    try {
      const result = await record.run(context);
      if (!TERMINAL.has(job.state)) this.finish(record, 'succeeded', { result });
    } catch (error) {
      if (!TERMINAL.has(job.state)) {
        this.finish(record, 'failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      this.running.set(job.kind, Math.max(0, (this.running.get(job.kind) ?? 1) - 1));
      this.pump(job.kind);
    }
  }

  private finish(
    record: JobRecord,
    state: 'succeeded' | 'failed' | 'cancelled',
    detail: { result?: JsonValue; error?: string },
  ): void {
    const { job } = record;
    job.state = state;
    job.finishedAt = this.now().toISOString();
    if (detail.result !== undefined) job.result = detail.result;
    if (detail.error !== undefined) job.error = detail.error;
    this.emit(record, 'state', {
      state,
      ...(detail.result === undefined ? {} : { result: detail.result }),
      ...(detail.error === undefined ? {} : { error: detail.error }),
    });
    for (const listener of record.listeners) listener.onEnd();
    record.listeners.clear();
    this.pump(job.kind);
  }

  private emit(record: JobRecord, event: JobEvent['event'], data: JsonValue): void {
    const entry: JobEvent = { id: (record.events.at(-1)?.id ?? 0) + 1, event, data };
    record.events.push(entry);
    if (record.events.length > MAX_EVENTS) record.events.shift();
    for (const listener of record.listeners) listener.onEvent(entry);
  }

  private prune(): void {
    const finished = [...this.records.values()].filter((record) => TERMINAL.has(record.job.state));
    for (const record of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      this.records.delete(record.job.id);
    }
  }
}
