/**
 * Render-thread side of the model worker: a model for "this class at this box" is built once, cached by key (entry + wanted
 * box) and handed out as blob URLs of GLBs the scene loads like any other file. One build runs at a time; while the user drags
 * a dimension, only the newest wanted size of each class waits behind it (older ones are skipped, nobody draws them).
 */
import { createValueStore } from '#state-backend';
import type { HoldingSummary, ToolDims } from '@hsw-editor/tools';
import type { RegenRequest, RegenResult } from './regenCore.ts';

export type { RegenRequest, RegenResult } from './regenCore.ts';
export type ToRegenWorker = RegenRequest;
export type FromRegenWorker =
  | { readonly type: 'built'; readonly result: RegenResult }
  | { readonly type: 'failed'; readonly key: string; readonly message: string };

export interface RegenPort {
  postMessage(message: ToRegenWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromRegenWorker>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

export interface BuiltModel {
  readonly status: 'ready';
  readonly hash: string;
  readonly reached: boolean;
  readonly lod0: string;
  readonly lod1: string;
  readonly dimsMm: ToolDims;
  readonly centreMm: ToolDims;
  readonly holding: HoldingSummary;
}

export type ModelBuild =
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly message: string }
  | BuiltModel;

/** Bumped whenever a build settles, so scene code that reads `ModelBuild` outside React state re-resolves. */
export const toolModelVersion = createValueStore<number>(0);

/** Built models kept (and their blob URLs alive); the oldest go first. */
const MAX_KEPT = 512;

export interface ObjectUrls {
  create(bytes: Uint8Array): string;
  revoke(url: string): void;
}

const releaseListeners = new Set<(url: string) => void>();

/** Hears every blob URL of a rebuilt model when it is let go, so the scene can drop it from its loader cache too. */
export function onModelUrlReleased(listener: (url: string) => void): void {
  releaseListeners.add(listener);
}

const browserUrls: ObjectUrls = {
  // `new Uint8Array(bytes)` copies into a plain ArrayBuffer: the transferred worker buffer is never shared.
  create: (bytes) =>
    URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'model/gltf-binary' })),
  revoke: (url) => {
    URL.revokeObjectURL(url);
    for (const listener of releaseListeners) listener(url);
  },
};

export class ModelRegen {
  private worker: RegenPort | null = null;
  private readonly builds = new Map<string, ModelBuild>();
  /** Waiting requests by class: a newer wanted size replaces an older one of the same class. */
  private readonly waiting = new Map<string, RegenRequest>();
  private running: string | null = null;

  constructor(
    private readonly spawn: () => RegenPort,
    private readonly urls: ObjectUrls = browserUrls,
    private readonly onSettled: () => void = () => toolModelVersion.set(toolModelVersion.get() + 1),
    private readonly maxKept: number = MAX_KEPT,
  ) {}

  /** The build for `key`, or `undefined` before it was ever asked for. */
  get(key: string): ModelBuild | undefined {
    return this.builds.get(key);
  }

  /** Starts the build of `request` unless it exists, is running or failed (a failure is not retried: same input, same error). */
  request(request: RegenRequest): ModelBuild {
    const known = this.builds.get(request.key);
    if (known) {
      // Used again: it is the newest, so trimming drops what the wall no longer asks for first.
      this.builds.delete(request.key);
      this.builds.set(request.key, known);
      return known;
    }
    const pending: ModelBuild = { status: 'pending' };
    this.builds.set(request.key, pending);
    const replaced = this.waiting.get(request.classId);
    if (replaced) this.builds.delete(replaced.key);
    this.waiting.set(request.classId, request);
    this.pump();
    return pending;
  }

  private ensureWorker(): RegenPort {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    worker.onmessage = (event) => this.receive(event.data);
    worker.onerror = (event) => this.crash(event.message || 'the model worker failed');
    this.worker = worker;
    return worker;
  }

  private pump(): void {
    if (this.running !== null) return;
    const next = this.waiting.values().next();
    if (next.done) return;
    this.waiting.delete(next.value.classId);
    this.running = next.value.key;
    try {
      this.ensureWorker().postMessage(next.value);
    } catch (error) {
      this.crash(error instanceof Error ? error.message : String(error));
    }
  }

  private receive(message: FromRegenWorker): void {
    const key = message.type === 'built' ? message.result.key : message.key;
    if (message.type === 'built') {
      const { result } = message;
      this.builds.set(key, {
        status: 'ready',
        hash: result.hash,
        reached: result.reached,
        lod0: this.urls.create(result.lod0),
        lod1: this.urls.create(result.lod1),
        dimsMm: result.dimsMm,
        centreMm: result.centreMm,
        holding: result.holding,
      });
      this.trim();
    } else {
      this.builds.set(key, { status: 'failed', message: message.message });
    }
    this.running = null;
    this.onSettled();
    this.pump();
  }

  /**
   * The worker died (script error, out of memory): the build it was running fails (same input, same crash); what only waited
   * is untouched and is built by a new worker.
   */
  private crash(message: string): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.running !== null) this.builds.set(this.running, { status: 'failed', message });
    this.running = null;
    // Possibly reached from a render (the worker could not be created): the store is told after it.
    queueMicrotask(this.onSettled);
    this.pump();
  }

  private trim(): void {
    while (this.builds.size > this.maxKept) {
      const oldest = this.builds.entries().next();
      if (oldest.done) return;
      const [key, build] = oldest.value;
      if (key === this.running) return;
      if (build.status === 'ready') {
        this.urls.revoke(build.lod0);
        this.urls.revoke(build.lod1);
      }
      this.builds.delete(key);
    }
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const build of this.builds.values()) {
      if (build.status === 'ready') {
        this.urls.revoke(build.lod0);
        this.urls.revoke(build.lod1);
      }
    }
    this.builds.clear();
    this.waiting.clear();
    this.running = null;
  }
}
