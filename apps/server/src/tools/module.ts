/**
 * Server module for tools: mounts `/api/tools/*` and registers the `tools.analyze` job.
 *
 * Data (under the daemon's `config.home`): `tools/` (library + `.drafts/`), `tools-assets/` (content-hashed LOD0/LOD1 GLBs
 * of every class and user tool, served at `/tools/assets/*`), `tools-prototypes/` (recognition
 * prototypes built by `bun run tools:prototypes`; optional). The class vocabulary for the sidecar (`classes.json`)
 * is written next to the prototypes whenever the registered classes change.
 *
 * The stores are created once per data directory; a failed start-up (unwritable directory) is retried on the next
 * request instead of being cached.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listToolClasses, recognitionCategories } from '@hsw-editor/tools';
import {
  DraftStore,
  HttpVisionPort,
  ToolAssetStore,
  ToolStore,
  analyzeDraft,
  loadPrototypeIndex,
  recoverInterruptedDrafts,
  type DraftDeps,
  type VisionPort,
} from '@hsw-editor/tools/node';
import { z } from 'zod';
import type { DrawRuntime } from '../draw/runtime.ts';
import { sharedDrawRuntime } from '../draw/shared.ts';
import { defaultJobRegistry, registerJob, type JobRegistry } from '../jobs.ts';
import type { ServerModule } from '../modules.ts';
import type { VisionClient } from '../vision/client.ts';
import { visionClient as sharedVisionClient } from '../vision/shared.ts';
import { handleToolAssets } from './assets.ts';
import {
  type DrawViewDeps,
  type DrawnViewChecker,
  DrawViewInputSchema,
  TOOLS_DRAW_VIEW_JOB,
  runDrawView,
  sidecarChecker,
  toJson,
} from './draw-view.ts';
import { handleToolsRequest } from './routes.ts';
import { ManagedVisionTransport } from './vision-transport.ts';

export interface ToolsModuleOptions {
  /** Test seam: a vision sidecar stand-in. */
  vision?: VisionPort;
  /** Test seam: another managed client than the daemon's one (own environment and state file). */
  visionClient?: VisionClient;
  /** Job registry the `tools.analyze` and `tools.draw_view` jobs are registered in (the daemon's default one). */
  jobRegistry?: JobRegistry;
  /** Test seam: a draw runtime with fake backends and a scratch data directory (default: the daemon's shared one). */
  drawRuntime?: DrawRuntime;
  /** Test seam: how drawn views are scored against the sidecar's fit (default: the managed sidecar's `/multiview`). */
  drawnViewChecker?: DrawnViewChecker;
}

export const TOOLS_ANALYZE_JOB = 'tools.analyze';

async function writeCategories(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'classes.json');
  const next = `${JSON.stringify(recognitionCategories(), null, 1)}\n`;
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current !== next) await writeFile(file, next);
  return file;
}

async function openDeps(home: string, vision: VisionPort): Promise<DraftDeps> {
  const tools = new ToolStore(join(home, 'tools'));
  const drafts = new DraftStore(join(home, 'tools', '.drafts'));
  await mkdir(drafts.root, { recursive: true });
  await recoverInterruptedDrafts(drafts);
  const protoDir = join(home, 'tools-prototypes');
  return {
    tools,
    drafts,
    vision,
    index: await loadPrototypeIndex(
      protoDir,
      listToolClasses().map((c) => c.id),
    ),
    categoriesPath: await writeCategories(protoDir),
  };
}

export function createToolsModule(options: ToolsModuleOptions = {}): ServerModule {
  const visionClient = options.visionClient ?? sharedVisionClient;
  const vision = options.vision ?? new HttpVisionPort(new ManagedVisionTransport(visionClient));
  const drawRuntime = (home: string): DrawRuntime => options.drawRuntime ?? sharedDrawRuntime(home);
  const check = options.drawnViewChecker ?? sidecarChecker(visionClient);
  /** Registry this module instance already put its jobs in: a restart in one process must not register twice. */
  let registeredIn: JobRegistry | null = null;
  const opened = new Map<string, Promise<DraftDeps>>();
  const assetStores = new Map<string, Promise<ToolAssetStore>>();
  const depsFor = (home: string): Promise<DraftDeps> => {
    let deps = opened.get(home);
    if (!deps) {
      deps = openDeps(home, vision);
      opened.set(home, deps);
      deps.catch(() => opened.delete(home));
    }
    return deps;
  };

  // One store per data directory, created once even when the first requests arrive together (it owns the write queue).
  const assetsFor = (home: string): Promise<ToolAssetStore> => {
    let store = assetStores.get(home);
    if (!store) {
      store = depsFor(home).then(
        (deps) => new ToolAssetStore(join(home, 'tools-assets'), deps.tools),
      );
      assetStores.set(home, store);
      store.catch(() => assetStores.delete(home));
    }
    return store;
  };

  return {
    name: 'tools',
    init() {
      const registry = options.jobRegistry ?? defaultJobRegistry;
      // jobs read the data home of the daemon that runs them from `ctx.home`
      if (registeredIn === registry) return;
      registerJob(
        {
          kind: TOOLS_ANALYZE_JOB,
          inputSchema: z.strictObject({ draftId: z.string() }),
          concurrency: 1,
          async run(input, ctx) {
            const draft = await analyzeDraft(await depsFor(ctx.home), input.draftId, {
              signal: ctx.signal,
              onProgress: (done, total, message) => ctx.progress({ done, total, message }),
            });
            return {
              draftId: draft.id,
              state: draft.state,
              objects: draft.objects.length,
              needsScale: draft.objects.filter((o) => o.needsScale).length,
            };
          },
        },
        registry,
      );
      registerJob(
        {
          kind: TOOLS_DRAW_VIEW_JOB,
          inputSchema: DrawViewInputSchema,
          concurrency: 1,
          async run(input, ctx) {
            const home = ctx.home;
            const deps: DrawViewDeps = {
              drafts: await depsFor(home),
              runtime: drawRuntime(home),
              check,
            };
            const result = await runDrawView(deps, input, ctx);
            return toJson(result);
          },
        },
        registry,
      );
      registeredIn = registry;
    },
    handle(request, deps) {
      const { pathname } = new URL(request.url);
      const home = deps.config.home;
      if (pathname.startsWith('/tools/assets/') || pathname.startsWith('/api/tools/assets/')) {
        return assetsFor(home).then((store) => handleToolAssets(request, store));
      }
      if (pathname !== '/api/tools' && !pathname.startsWith('/api/tools/')) return null;
      if (pathname === '/api/tools/vision') {
        // answers even when the tool store cannot be opened: it only asks the sidecar (never starts it)
        if (request.method !== 'GET') {
          return Response.json(
            { error: { code: 'method_not_allowed', message: 'GET only' } },
            { status: 405 },
          );
        }
        return vision.status().then((status) => Response.json(status));
      }
      return depsFor(home).then((d) =>
        handleToolsRequest(request, d, home, { jobs: deps.jobs, draw: drawRuntime(home) }),
      );
    },
  };
}
