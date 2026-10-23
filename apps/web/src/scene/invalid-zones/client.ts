/**
 * Render-thread side of the worker: defines each solid once, keeps at most one solve in flight and always
 * solves the newest scene next (pointer moves arrive faster than exact booleans finish; stale scenes are skipped).
 */
import type { Board } from '@hsw-editor/core';
import type { EngineItem, SolveResult } from './engine.ts';
import type { FromWorker, SolidSource, ToWorker } from './protocol.ts';

export interface WorkerPort {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  /** The worker script itself failed (import error, CSP block, ...). */
  onerror: ((event: ErrorEvent) => void) | null;
  /** A message could not be deserialised. */
  onmessageerror: ((event: MessageEvent) => void) | null;
}

interface Scene {
  readonly board: Board;
  readonly items: readonly EngineItem[];
}

export class InvalidZoneClient {
  private readonly worker: WorkerPort;
  private readonly defined = new Set<string>();
  private seq = 0;
  private inFlight = false;
  private queued: Scene | null = null;
  private applied = 0;
  private sentAt = 0;

  constructor(
    createWorker: () => WorkerPort,
    /** `roundTripMs`: post-to-answer time of the solve just answered; absent for a late re-solve of the same scene. */
    private readonly onResult: (result: SolveResult, roundTripMs?: number) => void,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.worker = createWorker();
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) =>
      this.onError(`worker failed: ${event.message ?? 'unknown error'}`);
    this.worker.onmessageerror = () => this.onError('worker message could not be deserialised');
  }

  /** Submits the current scene. `sources` must cover every solid key the items refer to. */
  update(
    board: Board,
    items: readonly EngineItem[],
    sources: ReadonlyMap<string, SolidSource>,
  ): void {
    for (const item of items) {
      const source = sources.get(item.solidKey);
      if (source && !this.defined.has(item.solidKey)) {
        try {
          this.worker.postMessage({ type: 'define', key: item.solidKey, source });
          this.defined.add(item.solidKey);
        } catch (error) {
          this.onError(
            `solid ${item.solidKey} could not be sent to the worker: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    if (this.inFlight) {
      this.queued = { board, items };
      return;
    }
    this.send({ board, items });
  }

  dispose(): void {
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
  }

  private send(scene: Scene): void {
    const seq = this.seq + 1;
    try {
      this.worker.postMessage({ type: 'solve', seq, board: scene.board, items: scene.items });
    } catch (error) {
      // Not cloneable (a store proxy, a function inside an item): nothing was sent, so nothing is in flight.
      this.onError(
        `scene could not be sent to the worker: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.seq = seq;
    this.inFlight = true;
    this.sentAt = performance.now();
  }

  private receive(message: FromWorker): void {
    if (message.type === 'notice' || message.type === 'fatal') {
      this.onError(message.message);
      return;
    }
    if (message.type === 'error') {
      this.onError(message.message);
      // A failed solve never answers its seq: free exactly that slot so the newest queued scene is still solved.
      if (message.seq === this.seq) this.release();
      return;
    }
    // A re-solve after a late solid definition answers the same seq; the newest answer wins.
    if (message.seq >= this.applied) {
      const first = message.seq > this.applied;
      this.applied = message.seq;
      this.onResult(
        message.result,
        first && message.seq === this.seq ? performance.now() - this.sentAt : undefined,
      );
    }
    if (message.seq === this.seq) this.release();
  }

  private release(): void {
    if (!this.inFlight) return;
    this.inFlight = false;
    const next = this.queued;
    this.queued = null;
    if (next) this.send(next);
  }
}
