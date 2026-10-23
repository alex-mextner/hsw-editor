/**
 * Message handling of the invalid-zone worker, free of `self`/Vite specifics so it is testable under bun.
 *
 * - `define` starts fetching a GLB url immediately and OFF the message chain (fetches run in parallel and never
 *   hold up a solve); when a fetch lands, the solid is registered on the chain. A failed fetch is reported as a
 *   `notice` and the bounding box stands in.
 * - `solve` stores the newest scene and answers it at once, items whose solid is still loading being skipped and
 *   listed as `pending`; earlier scenes are never answered late (latest wins).
 * - The scene is re-solved once, shortly after the last pending solid lands, instead of once per solid (a
 *   200-item wall refers to ~100 GLBs).
 * - A throwing solve is reported as an `error` carrying its `seq` (the client frees exactly that slot); a failed
 *   engine load as a fatal one.
 */
import type { InvalidZoneEngine, SolidMesh, SolidSpec, SolveResult } from './engine.ts';
import type { FromWorker, SolidSource, ToWorker } from './protocol.ts';

export interface WorkerCoreDeps {
  readonly engine: Promise<InvalidZoneEngine>;
  readonly post: (message: FromWorker) => void;
  readonly fetchSolid: (url: string) => Promise<SolidMesh>;
  /** Runs `task` after `delayMs` (used to coalesce bursts of landing solids). */
  readonly schedule: (task: () => void, delayMs: number) => void;
}

const RESOLVE_QUIET_MS = 20;
const RESOLVE_MAX_WAIT_MS = 300;

type SolveMessage = Extract<ToWorker, { type: 'solve' }>;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class WorkerCore {
  private latest: SolveMessage | null = null;
  /** Solid keys the newest answer skipped; a solid landing for one of them makes the answer stale. */
  private pending = new Set<string>();
  private landed = false;
  private resolveScheduled = false;
  private resolveDelay = 0;
  private chain: Promise<void>;
  private readonly loads = new Set<Promise<void>>();

  constructor(private readonly deps: WorkerCoreDeps) {
    // Messages are handled strictly in order; the chain never rejects.
    this.chain = deps.engine.then(
      () => undefined,
      (error: unknown) => {
        deps.post({ type: 'fatal', message: `manifold failed to load: ${messageOf(error)}` });
      },
    );
  }

  /** Resolves when everything received so far has been handled (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      await Promise.all([...this.loads, chain]);
      if (this.loads.size === 0 && chain === this.chain) return;
    }
  }

  handle(message: ToWorker): void {
    if (message.type === 'define') {
      const { key, source } = message;
      if (source.kind === 'box') {
        this.chain = this.chain.then(() => this.register(key, { kind: 'box', box: source.box }));
        return;
      }
      // Queue the registration only once the fetch has landed, so it never blocks a solve behind it.
      const load = this.load(key, source).then((solid) => {
        this.chain = this.chain.then(() => this.register(key, solid));
        this.loads.delete(load);
      });
      this.loads.add(load);
      return;
    }
    this.chain = this.chain.then(() => this.run(message));
  }

  /** Starts the (possibly slow) fetch right away; never rejects. */
  private async load(
    key: string,
    source: Extract<SolidSource, { kind: 'glb' }>,
  ): Promise<SolidSpec> {
    try {
      const mesh = await this.deps.fetchSolid(source.url);
      if (mesh.indices.length < 3) throw new Error('the model has no triangles');
      return { kind: 'mesh', mesh };
    } catch (error) {
      this.deps.post({ type: 'notice', message: `solid ${key}: ${messageOf(error)}` });
      return { kind: 'box', box: source.fallbackBox };
    }
  }

  private async register(key: string, solid: SolidSpec): Promise<void> {
    let engine: InvalidZoneEngine;
    try {
      engine = await this.deps.engine;
    } catch {
      return; // already reported as fatal
    }
    try {
      engine.defineSolid(key, solid);
      if (engine.approximateSolids.has(key)) {
        this.deps.post({
          type: 'notice',
          message: `solid ${key}: the model is not a closed solid, its bounding box stands in (overlaps may be overstated)`,
        });
      }
      if (this.pending.has(key)) this.landed = true;
      // Re-solve when the burst of downloads is over, but at the latest after RESOLVE_MAX_WAIT_MS: a download that
      // hangs, or a key nobody ever defines, must not keep the solids that did land unchecked.
      if (this.landed)
        this.scheduleResolve(
          engine,
          this.loads.size === 0 ? RESOLVE_QUIET_MS : RESOLVE_MAX_WAIT_MS,
        );
    } catch (error) {
      this.deps.post({ type: 'notice', message: `solid ${key}: ${messageOf(error)}` });
    }
  }

  private async run(message: SolveMessage): Promise<void> {
    let engine: InvalidZoneEngine;
    try {
      engine = await this.deps.engine;
    } catch {
      return; // already reported as fatal
    }
    this.latest = message;
    this.solveLatest(engine);
  }

  private scheduleResolve(engine: InvalidZoneEngine, delayMs: number): void {
    if (this.resolveScheduled && delayMs >= this.resolveDelay) return;
    this.resolveScheduled = true;
    this.resolveDelay = delayMs;
    this.deps.schedule(() => {
      if (!this.resolveScheduled) return;
      this.resolveScheduled = false;
      this.chain = this.chain.then(() => {
        this.solveLatest(engine);
      });
    }, delayMs);
  }

  /** Solves and answers the newest scene; a throw is reported against that scene's seq and never escapes. */
  private solveLatest(engine: InvalidZoneEngine): void {
    const scene = this.latest;
    if (!scene) return;
    try {
      const result: SolveResult = engine.solve(scene.board, scene.items);
      this.pending = new Set(result.pending);
      this.landed = false;
      this.deps.post({ type: 'result', seq: scene.seq, result });
    } catch (error) {
      this.deps.post({ type: 'error', seq: scene.seq, message: messageOf(error) });
    }
  }
}
