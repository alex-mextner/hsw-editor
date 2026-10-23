/**
 * Server module for tools: mounts `/api/tools/*` and registers the `tools.analyze` job.
 *
 * Data (under the daemon's `config.home`): `tools/` (library + `.drafts/`), `tools-prototypes/` (recognition
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
import { handleToolsRequest } from './routes.ts';

export interface ToolsModuleOptions {
  /** Test seam: a vision sidecar stand-in. */
  vision?: VisionPort;
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

async function openDeps(home: string, vision: VisionPort | undefined): Promise<DraftDeps> {
  const tools = new ToolStore(join(home, 'tools'));
  const drafts = new DraftStore(join(home, 'tools', '.drafts'));
  await mkdir(drafts.root, { recursive: true });
  await recoverInterruptedDrafts(drafts);
  const protoDir = join(home, 'tools-prototypes');
  return {
    tools,
    drafts,
    vision: vision ?? new HttpVisionPort(process.env['HSW_VISION_URL'] ?? 'http://127.0.0.1:8795'),
    index: await loadPrototypeIndex(
      protoDir,
      listToolClasses().map((c) => c.id),
    ),
    categoriesPath: await writeCategories(protoDir),
  };
}

export function createToolsModule(options: ToolsModuleOptions = {}): ServerModule {
  const opened = new Map<string, Promise<DraftDeps>>();
  /** Data directory of the daemon this module is mounted in (jobs carry no config; set by the first request). */
  let lastHome: string | null = null;

  const depsFor = (home: string): Promise<DraftDeps> => {
    let deps = opened.get(home);
    if (!deps) {
      deps = openDeps(home, options.vision);
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

  return {
    name: 'tools',
    handle(request, deps) {
      lastHome = deps.config.home;
      const url = new URL(request.url);
      if (url.pathname !== '/api/tools' && !url.pathname.startsWith('/api/tools/')) return null;
      return depsFor(deps.config.home).then((d) =>
        handleToolsRequest(request, d, deps.config.home),
      );
    },
  };
}
