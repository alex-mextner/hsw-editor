/**
 * Message handling of the physics worker, free of `self`/Vite specifics so it is testable under bun.
 *
 * - `define` starts fetching a model at once and off the job chain (downloads run in parallel); a download that fails
 *   is remembered as missing (`retry`: the client defines it again on its next run), a tool model without mass data
 *   as permanently missing.
 * - `solve` (the whole wall) and `rank` (seat one tool in candidate holders) run one at a time, in arrival order, each
 *   after the models it needs have landed. The client keeps one `solve` in flight and always sends the newest wall, so
 *   nothing stale is ever computed here.
 * - Posed solids are cached by (item, model, pose): rasterising a holder is the expensive part and an unchanged
 *   holder keeps its grid from one run to the next.
 * - A throwing job is reported as an `error` carrying its `seq` (the client frees exactly that job); a failed WASM load
 *   as a fatal one.
 */
import type { Pose } from '@hsw-editor/core';
import { matrixToEuler } from '@hsw-editor/compat';
import {
  analyseWallPhysics,
  type HolderCandidate,
  planFall,
  rankHolders,
  SolidBody,
  type ToolBody,
  type WallHolder,
  type WallTool,
  placementOfPose,
  type TriMesh,
} from '@hsw-editor/physics';
import type { ManifoldToplevel } from 'manifold-3d';
import { LruCache } from '@/scene/invalid-zones/lru.ts';
import type {
  BodySource,
  FallRequest,
  FromWorker,
  MissingBody,
  PhysicsScene,
  PlacedBody,
  RankRequest,
  ToWorker,
} from './protocol.ts';

export interface WorkerCoreDeps {
  readonly wasm: Promise<ManifoldToplevel>;
  readonly post: (message: FromWorker) => void;
  readonly fetchSolid: (url: string) => Promise<TriMesh>;
  /** Null when the model carries no mass data (it cannot be balanced). */
  readonly fetchTool: (url: string, id: string) => Promise<ToolBody | null>;
}

type Loaded =
  | { readonly kind: 'solid'; readonly mesh: TriMesh }
  | { readonly kind: 'tool'; readonly body: ToolBody }
  | { readonly kind: 'missing'; readonly retry: boolean };

/** Posed solids kept between runs; a 100-item wall is well inside. */
const POSED_CACHE = 400;
/** Models (meshes of holders and tools) kept loaded. */
const MODEL_CACHE = 150;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function poseKey(pose: Pose): string {
  return `${pose.x},${pose.y},${pose.z},${pose.rotX},${pose.rotY},${pose.rotZ}`;
}

export class WorkerCore {
  private chain: Promise<void> = Promise.resolve();
  /** Loaded models by key; the least recently used go when an edited dimension has made many variants. */
  private readonly loads = new LruCache<Promise<Loaded>>(MODEL_CACHE);
  private readonly inflight = new Set<Promise<Loaded>>();
  /** Where each defined key comes from, kept after eviction so a needed model can be fetched again. */
  private readonly sources = new Map<string, BodySource>();
  private readonly posed = new LruCache<SolidBody>(POSED_CACHE);
  /** Keys whose last download failed: a repeated `define` fetches them again. */
  private readonly retryable = new Set<string>();

  constructor(private readonly deps: WorkerCoreDeps) {
    // The jobs need the WASM: say so once, up front, instead of with every failed job.
    deps.wasm.catch((error: unknown) => {
      deps.post({ type: 'fatal', message: `manifold failed to load: ${messageOf(error)}` });
    });
  }

  /** Resolves when everything received so far has been handled (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const chain = this.chain;
      await Promise.all([...this.inflight, chain]);
      if (chain === this.chain) return;
    }
  }

  handle(message: ToWorker): void {
    switch (message.type) {
      case 'define':
        this.define(message.key, message.source);
        return;
      case 'solve':
        this.chain = this.chain.then(() => this.solve(message.seq, message.scene));
        return;
      case 'rank':
        this.chain = this.chain.then(() => this.rank(message.seq, message.request));
        return;
      case 'fall':
        this.chain = this.chain.then(() => this.fall(message.seq, message.request));
        return;
    }
  }

  private define(key: string, source: BodySource): void {
    this.sources.set(key, source);
    if (this.loads.has(key) && !this.retryable.has(key)) return;
    this.retryable.delete(key);
    this.start(key, source);
  }

  private start(key: string, source: BodySource): Promise<Loaded> {
    const pending = this.load(key, source);
    this.inflight.add(pending);
    void pending.finally(() => this.inflight.delete(pending));
    this.loads.set(key, pending);
    return pending;
  }

  /** Starts the (possibly slow) fetch right away; never rejects. */
  private async load(key: string, source: BodySource): Promise<Loaded> {
    try {
      if (source.kind === 'solid') {
        const mesh = await this.deps.fetchSolid(source.url);
        if (mesh.indices.length < 3) throw new Error('the model has no triangles');
        return { kind: 'solid', mesh };
      }
      const body = await this.deps.fetchTool(source.url, key);
      if (body === null) {
        this.deps.post({
          type: 'notice',
          message: `model ${key}: no mass data in the file, the tool is not analysed`,
        });
        return { kind: 'missing', retry: false };
      }
      if (body.mesh.indices.length < 3) throw new Error('the model has no triangles');
      return { kind: 'tool', body };
    } catch (error) {
      this.retryable.add(key);
      this.deps.post({ type: 'notice', message: `model ${key}: ${messageOf(error)}` });
      return { kind: 'missing', retry: true };
    }
  }

  private async loaded(keys: ReadonlySet<string>): Promise<Map<string, Loaded>> {
    const out = new Map<string, Loaded>();
    await Promise.all(
      [...keys].map(async (key) => {
        // Evicted since it was defined (a long session of edited dimensions): fetch it again from its source.
        const source = this.sources.get(key);
        const pending =
          this.loads.get(key) ?? (source === undefined ? undefined : this.start(key, source));
        // Never defined: the next run defines it.
        out.set(key, pending === undefined ? { kind: 'missing', retry: true } : await pending);
      }),
    );
    return out;
  }

  private missingOf(models: ReadonlyMap<string, Loaded>): MissingBody[] {
    const out: MissingBody[] = [];
    for (const [key, model] of models) {
      if (model.kind === 'missing') out.push({ key, retry: model.retry });
    }
    return out;
  }

  /** The posed solid of `body`; undefined when its model is missing. */
  private solidOf(body: PlacedBody, models: ReadonlyMap<string, Loaded>): SolidBody | undefined {
    const model = models.get(body.bodyKey);
    if (model === undefined || model.kind === 'missing') return undefined;
    const key = `${body.id}|${body.bodyKey}|${poseKey(body.pose)}`;
    let solid = this.posed.get(key);
    if (solid === undefined) {
      const mesh = model.kind === 'solid' ? model.mesh : model.body.mesh;
      const placement = placementOfPose(body.pose);
      solid = new SolidBody(body.id, mesh, placement.rotation, placement.position);
      this.posed.set(key, solid);
    }
    return solid;
  }

  private async wasm(): Promise<ManifoldToplevel> {
    try {
      return await this.deps.wasm;
    } catch (error) {
      throw new Error(`manifold failed to load: ${messageOf(error)}`);
    }
  }

  private async solve(seq: number, scene: PhysicsScene): Promise<void> {
    try {
      const wasm = await this.wasm();
      const keys = new Set<string>();
      for (const body of [...scene.holders, ...scene.tools, ...scene.others])
        keys.add(body.bodyKey);
      const models = await this.loaded(keys);

      const holders: WallHolder[] = [];
      for (const holder of scene.holders) {
        const body = this.solidOf(holder, models);
        if (body !== undefined) holders.push({ id: holder.id, body });
      }
      const others: SolidBody[] = [];
      for (const other of scene.others) {
        const body = this.solidOf(other, models);
        if (body !== undefined) others.push(body);
      }
      const holderIds = new Set(holders.map((h) => h.id));
      const tools: WallTool[] = [];
      const skipped: string[] = [];
      for (const tool of scene.tools) {
        const model = models.get(tool.bodyKey);
        const usable =
          model?.kind === 'tool' && (tool.holderId === null || holderIds.has(tool.holderId));
        if (!usable) {
          skipped.push(tool.id);
          continue;
        }
        tools.push({
          id: tool.id,
          body: { ...model.body, id: tool.id },
          placement: placementOfPose(tool.pose),
          holderId: tool.holderId,
          maxLoadG: tool.maxLoadG,
          protrudeLimitMm: tool.protrudeLimitMm,
        });
      }
      const report = analyseWallPhysics({ tools, holders, others, wasm });
      this.deps.post({ type: 'result', seq, report, skipped, missing: this.missingOf(models) });
    } catch (error) {
      this.deps.post({ type: 'error', seq, message: messageOf(error) });
    }
  }

  private async rank(seq: number, request: RankRequest): Promise<void> {
    try {
      const wasm = request.removal ? await this.wasm() : undefined;
      const keys = new Set<string>([request.tool.bodyKey]);
      for (const body of [...request.candidates.map((c) => c.holder), ...request.neighbours]) {
        keys.add(body.bodyKey);
      }
      const models = await this.loaded(keys);
      const missing = this.missingOf(models);
      const tool = models.get(request.tool.bodyKey);
      if (tool?.kind !== 'tool') {
        this.deps.post({ type: 'ranked', seq, seats: [], missing });
        return;
      }
      const neighbours: SolidBody[] = [];
      for (const body of request.neighbours) {
        const solid = this.solidOf(body, models);
        if (solid !== undefined) neighbours.push(solid);
      }
      const candidates: HolderCandidate[] = [];
      for (const candidate of request.candidates) {
        const holder = this.solidOf(candidate.holder, models);
        if (holder === undefined) continue;
        candidates.push({
          holderId: candidate.holder.id,
          holder,
          neighbours: neighbours.filter((n) => n.id !== candidate.holder.id),
          anchor: candidate.anchor,
          halfWidthMm: candidate.halfWidthMm,
          tipDown: candidate.tipDown,
          compatScore: candidate.compatScore,
          maxLoadG: candidate.maxLoadG,
          protrudeLimitMm: candidate.protrudeLimitMm,
        });
      }
      const seats = rankHolders({ ...tool.body, id: request.tool.id }, candidates, {
        ...(wasm === undefined ? {} : { wasm }),
      });
      this.deps.post({ type: 'ranked', seq, seats, missing });
    } catch (error) {
      this.deps.post({ type: 'error', seq, message: messageOf(error) });
    }
  }

  private async fall(seq: number, request: FallRequest): Promise<void> {
    try {
      const keys = new Set<string>([request.tool.bodyKey]);
      for (const body of request.neighbours) keys.add(body.bodyKey);
      const models = await this.loaded(keys);
      const missing = this.missingOf(models);
      const tool = models.get(request.tool.bodyKey);
      if (tool?.kind !== 'tool') {
        this.deps.post({ type: 'fell', seq, plan: null, missing });
        return;
      }
      const obstacles: SolidBody[] = [];
      for (const body of request.neighbours) {
        const solid = this.solidOf(body, models);
        if (solid !== undefined) obstacles.push(solid);
      }
      // A neighbour whose model did not load may be what holds the tool: no decision is better than a false fall.
      if (obstacles.length < request.neighbours.length) {
        this.deps.post({ type: 'fell', seq, plan: null, missing });
        return;
      }
      const plan = planFall({
        tool: { ...tool.body, id: request.tool.id },
        placement: placementOfPose(request.tool.pose),
        obstacles,
        floorYMm: request.floorYMm,
        floorDepthMm: request.floorDepthMm,
      });
      this.deps.post({
        type: 'fell',
        seq,
        plan: plan.falls
          ? {
              falls: true,
              report: plan.report,
              rest: {
                ...matrixToEuler(plan.rest.rotation),
                x: plan.rest.position[0],
                y: plan.rest.position[1],
                z: plan.rest.position[2],
              },
              dropMm: plan.dropMm,
              landedOn: plan.landedOn,
            }
          : { falls: false, report: plan.report },
        missing,
      });
    } catch (error) {
      this.deps.post({ type: 'error', seq, message: messageOf(error) });
    }
  }
}
