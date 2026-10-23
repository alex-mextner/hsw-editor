/** Test doubles for the Cache API and the runtime-cache dependencies (no browser needed). */
import { createMemoryStore } from '../offline/kv.ts';
import type { AssetCacheDeps } from './assetCache.ts';
import type { AssetEntry } from './cachePolicy.ts';
import { AssetRegistry, parseAssetEntry } from './registry.ts';

export class FakeCache {
  readonly entries = new Map<string, Response>();
  /** Throw this on the next `put` (once). */
  failNextPut: Error | null = null;
  puts = 0;

  match(request: Request | string): Promise<Response | undefined> {
    const url = typeof request === 'string' ? request : request.url;
    return Promise.resolve(this.entries.get(url)?.clone());
  }

  put(request: Request | string, response: Response): Promise<void> {
    if (this.failNextPut) {
      const error = this.failNextPut;
      this.failNextPut = null;
      return Promise.reject(error);
    }
    this.puts += 1;
    this.entries.set(typeof request === 'string' ? request : request.url, response);
    return Promise.resolve();
  }

  delete(request: Request | string): Promise<boolean> {
    return Promise.resolve(
      this.entries.delete(typeof request === 'string' ? request : request.url),
    );
  }

  keys(): Promise<Request[]> {
    return Promise.resolve([...this.entries.keys()].map((url) => new Request(url)));
  }
}

export class FakeCacheStorage {
  readonly stores = new Map<string, FakeCache>();

  open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.stores.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  cache(name: string): FakeCache {
    const cache = this.stores.get(name);
    if (!cache) throw new Error(`no cache ${name}`);
    return cache;
  }
}

export interface Harness {
  readonly deps: AssetCacheDeps;
  readonly storage: FakeCacheStorage;
  readonly registry: AssetRegistry;
  /** Background work scheduled through `waitUntil`; `settle()` awaits all of it. */
  settle(): Promise<void>;
  /** Network: set `online`, `respond` or `calls` to script it. */
  net: {
    online: boolean;
    calls: string[];
    respond: (url: string) => Response;
  };
  setBudget(bytes: number): void;
  setNow(ms: number): void;
  refused: [string, string][];
  errors: [string, unknown][];
}

export function bytesOf(size: number, headers: Record<string, string> = {}): Response {
  return new Response('x'.repeat(size), {
    status: 200,
    headers: { 'content-type': 'model/gltf-binary', 'content-length': String(size), ...headers },
  });
}

export function harness(): Harness {
  const storage = new FakeCacheStorage();
  const registry = new AssetRegistry(
    createMemoryStore<AssetEntry>(parseAssetEntry),
    () => state.now,
  );
  const background: Promise<unknown>[] = [];
  const refused: [string, string][] = [];
  const errors: [string, unknown][] = [];
  const state = { now: 1000, budget: 1_000_000 };
  const net: Harness['net'] = {
    online: true,
    calls: [],
    respond: () => bytesOf(10),
  };
  const deps: AssetCacheDeps = {
    caches: storage as unknown as CacheStorage,
    fetch: (request) => {
      net.calls.push(request.url);
      return net.online
        ? Promise.resolve(net.respond(request.url))
        : Promise.reject(new TypeError('Failed to fetch'));
    },
    registry,
    budget: () => Promise.resolve(state.budget),
    waitUntil: (work) => {
      background.push(work);
    },
    onRefused: (url, why) => refused.push([url, why]),
    onError: (url, error) => errors.push([url, error]),
  };
  return {
    deps,
    storage,
    registry,
    settle: async () => {
      while (background.length > 0) await background.shift();
    },
    net,
    setBudget: (bytes) => {
      state.budget = bytes;
    },
    setNow: (ms) => {
      state.now = ms;
    },
    refused,
    errors,
  };
}
