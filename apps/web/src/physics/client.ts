/**
 * Render-thread side of the physics worker: defines each model once, keeps at most one wall check in flight and
 * always checks the newest wall next (edits arrive faster than a check finishes; stale walls are skipped, their
 * callers get the newest answer). Seat/rank jobs are independent requests answered one by one.
 */
import type { RankedSeat, WallPhysicsReport } from '@hsw-editor/physics';
import type {
  BodySource,
  FromWorker,
  MissingBody,
  PhysicsScene,
  RankRequest,
  ToWorker,
} from './protocol.ts';

export interface WorkerPort {
  postMessage(message: ToWorker): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  /** The worker script itself failed (import error, CSP block, ...). */
  onerror: ((event: ErrorEvent) => void) | null;
  /** A message could not be deserialised. */
  onmessageerror: ((event: MessageEvent) => void) | null;
}

export interface WallCheck {
  readonly report: WallPhysicsReport;
  /** Tools left out because their model could not be used. */
  readonly skipped: readonly string[];
}

interface Waiter {
  readonly resolve: (check: WallCheck) => void;
  readonly reject: (error: Error) => void;
}

interface Queued {
  readonly scene: PhysicsScene;
  readonly waiters: Waiter[];
}

interface RankWaiter {
  readonly resolve: (seats: readonly RankedSeat[]) => void;
  readonly reject: (error: Error) => void;
}

/** The part of the client the post-steps and the ratings use; tests supply a fake. */
export interface PhysicsRanker {
  rank(
    request: RankRequest,
    sources: ReadonlyMap<string, BodySource>,
  ): Promise<readonly RankedSeat[]>;
}

export interface PhysicsChecker {
  check(scene: PhysicsScene, sources: ReadonlyMap<string, BodySource>): Promise<WallCheck>;
}

export class PhysicsClient implements PhysicsRanker, PhysicsChecker {
  private readonly worker: WorkerPort;
  private readonly defined = new Set<string>();
  private seq = 0;
  private inFlight: { readonly seq: number; readonly waiters: Waiter[] } | null = null;
  private queued: Queued | null = null;
  private readonly ranks = new Map<number, RankWaiter>();
  private disposed = false;

  constructor(
    createWorker: () => WorkerPort,
    private readonly onError: (message: string) => void = () => undefined,
  ) {
    this.worker = createWorker();
    this.worker.onmessage = (event) => this.receive(event.data);
    this.worker.onerror = (event) =>
      this.fail(`worker failed: ${event.message ?? 'unknown error'}`);
    this.worker.onmessageerror = () => this.fail('worker message could not be deserialised');
  }

  /**
   * Checks `scene`. While a check runs the newest scene waits (older queued ones are dropped) and its waiters all
   * receive the answer of the newest scene. Rejects when the worker cannot answer.
   */
  check(scene: PhysicsScene, sources: ReadonlyMap<string, BodySource>): Promise<WallCheck> {
    const { promise, resolve, reject } = Promise.withResolvers<WallCheck>();
    const waiter: Waiter = { resolve, reject };
    if (!this.define(scene, sources, reject)) return promise;
    if (this.inFlight !== null) {
      this.queued = { scene, waiters: [...(this.queued?.waiters ?? []), waiter] };
    } else {
      this.sendCheck({ scene, waiters: [waiter] });
    }
    return promise;
  }

  /** Seats a tool in the candidate holders and returns the seats best first. */
  rank(
    request: RankRequest,
    sources: ReadonlyMap<string, BodySource>,
  ): Promise<readonly RankedSeat[]> {
    const { promise, resolve, reject } = Promise.withResolvers<readonly RankedSeat[]>();
    const keys = [
      request.tool,
      ...request.candidates.map((c) => c.holder),
      ...request.neighbours,
    ].map((body) => body.bodyKey);
    if (!this.defineKeys(keys, sources, reject)) return promise;
    const seq = this.nextSeq();
    try {
      this.worker.postMessage({ type: 'rank', seq, request });
    } catch (error) {
      reject(new Error(`seat request could not be sent to the worker: ${describe(error)}`));
      return promise;
    }
    this.ranks.set(seq, { resolve, reject });
    return promise;
  }

  dispose(): void {
    this.disposed = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.onmessageerror = null;
    this.worker.terminate();
    this.rejectAll(new Error('the physics worker was stopped'));
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private define(
    scene: PhysicsScene,
    sources: ReadonlyMap<string, BodySource>,
    reject: (error: Error) => void,
  ): boolean {
    const keys = [...scene.holders, ...scene.tools, ...scene.others].map((b) => b.bodyKey);
    return this.defineKeys(keys, sources, reject);
  }

  /** Sends each model the worker does not have yet; false (and a rejection) when the worker is gone or a model cannot be sent. */
  private defineKeys(
    keys: readonly string[],
    sources: ReadonlyMap<string, BodySource>,
    reject: (error: Error) => void,
  ): boolean {
    if (this.disposed) {
      reject(new Error('the physics worker was stopped'));
      return false;
    }
    for (const key of keys) {
      const source = sources.get(key);
      if (source === undefined || this.defined.has(key)) continue;
      try {
        this.worker.postMessage({ type: 'define', key, source });
        this.defined.add(key);
      } catch (error) {
        reject(new Error(`model ${key} could not be sent to the worker: ${describe(error)}`));
        return false;
      }
    }
    return true;
  }

  private sendCheck(job: Queued): void {
    const seq = this.nextSeq();
    try {
      this.worker.postMessage({ type: 'solve', seq, scene: job.scene });
    } catch (error) {
      // Not cloneable: nothing was sent, so nothing is in flight.
      const failure = new Error(`wall could not be sent to the worker: ${describe(error)}`);
      for (const waiter of job.waiters) waiter.reject(failure);
      this.releaseCheck();
      return;
    }
    this.inFlight = { seq, waiters: job.waiters };
  }

  private releaseCheck(): void {
    this.inFlight = null;
    const next = this.queued;
    this.queued = null;
    if (next !== null) this.sendCheck(next);
  }

  /** Models that failed to download are defined again the next time a scene or request names them. */
  private forget(missing: readonly MissingBody[]): void {
    for (const { key, retry } of missing) if (retry) this.defined.delete(key);
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case 'notice':
        this.onError(message.message);
        return;
      case 'fatal':
        this.fail(message.message);
        return;
      case 'error': {
        this.onError(message.message);
        const failure = new Error(message.message);
        if (this.inFlight?.seq === message.seq) {
          const { waiters } = this.inFlight;
          for (const waiter of waiters) waiter.reject(failure);
          this.releaseCheck();
          return;
        }
        const rank = this.ranks.get(message.seq);
        if (rank !== undefined) {
          this.ranks.delete(message.seq);
          rank.reject(failure);
        }
        return;
      }
      case 'result': {
        this.forget(message.missing);
        if (this.inFlight?.seq !== message.seq) return;
        const { waiters } = this.inFlight;
        for (const waiter of waiters)
          waiter.resolve({ report: message.report, skipped: message.skipped });
        this.releaseCheck();
        return;
      }
      case 'ranked': {
        this.forget(message.missing);
        const rank = this.ranks.get(message.seq);
        if (rank === undefined) return;
        this.ranks.delete(message.seq);
        rank.resolve(message.seats);
        return;
      }
    }
  }

  /** The worker is unusable: everything waiting is rejected, later calls start from a clean slate. */
  private fail(message: string): void {
    this.onError(message);
    this.rejectAll(new Error(message));
  }

  private rejectAll(failure: Error): void {
    const waiting = [...(this.inFlight?.waiters ?? []), ...(this.queued?.waiters ?? [])];
    this.inFlight = null;
    this.queued = null;
    for (const waiter of waiting) waiter.reject(failure);
    const ranks = [...this.ranks.values()];
    this.ranks.clear();
    for (const rank of ranks) rank.reject(failure);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
