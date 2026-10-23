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
import { defaultJobRegistry, registerJob, type JobRegistry } from '../jobs.ts';
import type { ServerModule } from '../modules.ts';
import type { VisionClient } from '../vision/client.ts';
import { visionClient as sharedVisionClient } from '../vision/shared.ts';
import { handleToolAssets } from './assets.ts';
import { handleToolsRequest } from './routes.ts';
import { ManagedVisionTransport } from './vision-transport.ts';

export interface ToolsModuleOptions {
  /** Test seam: a vision sidecar stand-in. */
  vision?: VisionPort;
  /** Test seam: another managed client than the daemon's one (own environment and state file). */
  visionClient?: VisionClient;
  /** Job registry the `tools.analyze` job is registered in (the daemon's default one). */
  jobRegistry?: JobRegistry;
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
  const vision =
    options.vision ??
    new HttpVisionPort(new ManagedVisionTransport(options.visionClient ?? sharedVisionClient));
  const opened = new Map<string, Promise<DraftDeps>>();
  const assetStores = new Map<string, Promise<ToolAssetStore>>();
  /** Data directory of the daemon this module is mounted in (jobs carry no config; set by the first request). */
  let lastHome: string | null = null;

  const depsFor = (home: string): Promise<DraftDeps> => {
    let deps = opened.get(home);
    if (!deps) {
      deps = openDeps(home, vision);
      opened.set(home, deps);
      deps.catch(() => opened.delete(home));
    }
    return deps;
  };

  registerJob(
    {
      kind: TOOLS_ANALYZE_JOB,
      inputSchema: z.strictObject({ draftId: z.string() }),
      concurrency: 1,
      async run(input, ctx) {
        if (lastHome === null) throw new Error('the tools module has not served a request yet');
        const draft = await analyzeDraft(await depsFor(lastHome), input.draftId, {
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
    options.jobRegistry ?? defaultJobRegistry,
  );

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
    handle(request, deps) {
      lastHome = deps.config.home;
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
      return depsFor(home).then((d) => handleToolsRequest(request, d, home));
    },
  };
}
