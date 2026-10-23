/**
 * Warms the offline caches with what the page already knows it will need, so "one online visit" is enough:
 *
 *   - the tool library (list, classes, every tool's JSON, holding, thumbnail and preview model, class thumbnails), once the Tools panel's
 *     data is loaded;
 *   - the files of the open wall (every photo, including the cleaned variants that only photo mode shows, and every model).
 *
 * Without it a file is cached only after the app happened to request it under a controlling worker: the first visit is not controlled yet,
 * and a cleaned photo is requested only once photo mode is open, so photo mode would be blank offline although the photo thumbnail loads.
 * Files go through the same store as the worker's (`downloadAssets`, unpinned: the byte budget may still evict them; a file the user
 * pinned keeps its pin) and a file that is already cached costs one cache lookup.
 */
import { z } from 'zod';
import { toolRoutes } from '@/features/tools/api.ts';
import type { AssetCacheDeps } from './assetCache.ts';
import { INDEX_CACHE, routeFor } from './cachePolicy.ts';
import { wallMediaUrls, type DownloadOptions, type DownloadResult } from './storage.ts';

export interface LibraryTool {
  readonly id: string;
  /** The tool's version: part of its thumbnail and model URLs. */
  readonly updatedAt: string;
}

export interface LibrarySnapshot {
  readonly classes: readonly { readonly id: string }[];
  readonly tools: readonly LibraryTool[];
}

export interface WallSnapshot {
  readonly id: string;
  readonly photos: readonly { readonly id: string }[];
  readonly models: readonly { readonly id: string; readonly file?: string | undefined }[];
}

/** Every URL the Tools panel reads, built by the panel's own route table so the two cannot drift apart. */
export function libraryWarmUrls(library: LibrarySnapshot, origin: string): string[] {
  const paths: string[] = [toolRoutes.list, toolRoutes.classes];
  for (const cls of library.classes) paths.push(toolRoutes.classThumb(cls.id));
  for (const tool of library.tools) {
    paths.push(
      toolRoutes.tool(tool.id),
      toolRoutes.toolHolding(tool.id),
      toolRoutes.toolThumb(tool.id, tool.updatedAt),
      toolRoutes.toolGlb(tool.id, tool.updatedAt, 0),
    );
  }
  return paths.map((path) => `${origin}${path}`);
}

const CachedToolSchema = z.object({ tool: z.object({ updatedAt: z.string() }) });
const TOOL_PATH_PREFIX = '/api/tools/';
const HOLDING_SUFFIX = '/holding';

/**
 * The downloader skips what is cached, but the kept JSON of a tool (its URL carries no version) goes stale when the tool changes behind the page
 * and is useless when the tool is gone. Drops the kept JSON and holding of every tool the library no longer lists or lists at another version, so
 * the run that follows fetches them again.
 */
export async function dropStaleLibraryEntries(
  deps: Pick<AssetCacheDeps, 'caches' | 'registry'>,
  library: LibrarySnapshot,
  origin: string,
): Promise<string[]> {
  const versions = new Map(library.tools.map((tool) => [tool.id, tool.updatedAt]));
  const cache = await deps.caches.open(INDEX_CACHE);
  const kept: { readonly url: string; readonly id: string; readonly holding: boolean }[] = [];
  for (const key of await cache.keys()) {
    const url = new URL(key.url);
    if (routeFor(url, 'GET', false, origin)?.category !== 'tool-library') continue;
    const rest = url.pathname.slice(TOOL_PATH_PREFIX.length);
    if (url.pathname.length <= TOOL_PATH_PREFIX.length || rest === 'classes') continue;
    if (rest.startsWith('classes/')) continue;
    const holding = rest.endsWith(HOLDING_SUFFIX);
    kept.push({
      url: key.url,
      id: decodeURIComponent(holding ? rest.slice(0, -HOLDING_SUFFIX.length) : rest),
      holding,
    });
  }
  const staleIds = new Set<string>();
  for (const entry of kept) {
    const expected = versions.get(entry.id);
    if (expected === undefined) {
      staleIds.add(entry.id);
    } else if (!entry.holding) {
      const body = CachedToolSchema.safeParse(
        await cache
          .match(entry.url)
          .then((response) => response?.json())
          .catch(() => null),
      );
      if (!body.success || body.data.tool.updatedAt < expected) staleIds.add(entry.id);
    }
  }
  const urls = kept.filter((entry) => staleIds.has(entry.id)).map((entry) => entry.url);
  await Promise.all(urls.map((url) => cache.delete(url)));
  await deps.registry.remove(urls);
  return urls;
}

export interface Warmup {
  /** The loaded tool library changed (or loaded for the first time). */
  readonly library: (library: LibrarySnapshot | null) => void;
  /** The open wall changed; only a change of its photo or model files matters. */
  readonly wall: (wall: WallSnapshot | null) => void;
  /** Resolves when everything queued so far has finished (tests). */
  readonly idle: () => Promise<void>;
}

export interface WarmupOptions {
  readonly origin: string;
  readonly deps: () => Promise<AssetCacheDeps>;
  readonly download: (
    deps: AssetCacheDeps,
    urls: readonly string[],
    options: DownloadOptions,
  ) => Promise<DownloadResult>;
  readonly env?: DownloadOptions['env'];
}

const WARM_CONCURRENCY = 2;

export function createWarmup(options: WarmupOptions): Warmup {
  let queue: Promise<void> = Promise.resolve();
  /** Per scope (`library`, `wall:<id>`), the signature of the set last handed to the downloader. */
  const signatures = new Map<string, string>();

  const enqueue = (
    scope: string,
    urls: readonly string[],
    prepare?: (deps: AssetCacheDeps) => Promise<unknown>,
  ): void => {
    const signature = urls.join(',');
    if (signatures.get(scope) === signature) return;
    signatures.set(scope, signature);
    // A run that did not finish is forgotten (unless a newer set replaced it) so the next change or reconnect runs it again.
    const forget = (): void => {
      if (signatures.get(scope) === signature) signatures.delete(scope);
    };
    queue = queue.then(async () => {
      try {
        const deps = await options.deps();
        await prepare?.(deps);
        const result = await options.download(deps, urls, {
          origin: options.origin,
          pin: false,
          concurrency: WARM_CONCURRENCY,
          ...(options.env === undefined ? {} : { env: options.env }),
        });
        if (result.outcome !== 'complete') forget();
      } catch (error) {
        forget();
        console.error('[offline] warmup failed', error);
      }
    });
  };

  return {
    library: (library) => {
      if (library === null) return;
      enqueue('library', libraryWarmUrls(library, options.origin), (deps) =>
        dropStaleLibraryEntries(deps, library, options.origin),
      );
    },
    wall: (wall) => {
      if (wall === null) return;
      const urls = wallMediaUrls(wall, options.origin);
      if (urls.length === 0) return;
      enqueue(`wall:${wall.id}`, urls);
    },
    idle: () => queue,
  };
}
