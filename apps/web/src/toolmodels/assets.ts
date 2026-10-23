/**
 * The tool model asset index in the browser: loaded once from `/api/tools/assets/index` (the daemon's store, or the static copy the
 * demo build ships), revalidated on demand like the bank index. It says which generator class draws a bank tool class, where
 * the pre-generated LOD0/LOD1 GLBs of every class and user tool live, and what holds a tool in a holder.
 */
import { createValueStore } from '#state-backend';
import {
  TOOL_ASSET_INDEX_URL,
  ToolAssetIndexSchema,
  type ToolAssetEntry,
  type ToolAssetIndex,
} from '@hsw-editor/tools/contract';

export type ToolAssetsState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly at: number }
  | {
      readonly status: 'ready';
      readonly index: ToolAssetIndex;
      readonly byId: ReadonlyMap<string, ToolAssetEntry>;
      /** Generator class that draws each bank tool class (the class named like it first). */
      readonly byBankClass: ReadonlyMap<string, ToolAssetEntry>;
    };

export const toolAssetsStore = createValueStore<ToolAssetsState>({ status: 'idle' });

/** A failed first load is tried again after this long, when something asks for a tool model again. */
const RETRY_AFTER_MS = 15_000;

export function indexState(index: ToolAssetIndex): ToolAssetsState {
  const byId = new Map(index.entries.map((entry) => [entry.id, entry]));
  const byBankClass = new Map<string, ToolAssetEntry>();
  for (const entry of index.entries) {
    if (entry.kind !== 'class' || entry.bankClass === null) continue;
    const known = byBankClass.get(entry.bankClass);
    if (!known || entry.id === `class:${entry.bankClass}`) byBankClass.set(entry.bankClass, entry);
  }
  return { status: 'ready', index, byId, byBankClass };
}

let inflight: Promise<void> | null = null;

async function load(force: boolean): Promise<void> {
  const previous = toolAssetsStore.get();
  if (previous.status !== 'ready') toolAssetsStore.set({ status: 'loading' });
  try {
    // A forced load goes around the service worker's stale-while-revalidate copy (a query string is not a cached route).
    const response = await fetch(
      force ? `${TOOL_ASSET_INDEX_URL}?fresh=${Date.now()}` : TOOL_ASSET_INDEX_URL,
      {
        cache: force ? 'reload' : 'no-cache',
      },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const index = ToolAssetIndexSchema.parse(await response.json());
    if (previous.status !== 'ready' || previous.index.contentHash !== index.contentHash) {
      toolAssetsStore.set(indexState(index));
    }
  } catch (error) {
    // A failed refetch keeps the index we have; only a first load can fail visibly.
    if (previous.status !== 'ready') {
      toolAssetsStore.set({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
    }
  }
}

/** Loads (or revalidates) the index; concurrent calls share one request, a forced call goes again after a running one. */
export function refreshToolAssets(options: { readonly force?: boolean } = {}): Promise<void> {
  const force = options.force === true;
  if (inflight && !force) return inflight;
  const run = (inflight ?? Promise.resolve()).then(() => load(force));
  const tracked = run.finally(() => {
    if (inflight === tracked) inflight = null;
  });
  inflight = tracked;
  return tracked;
}

let loadScheduled = false;

/**
 * Starts the first load when nothing has asked yet (or the last attempt failed a while ago). Safe to call on every render: the
 * store is touched in a microtask, never while a component is rendering.
 */
export function ensureToolAssets(): void {
  const state = toolAssetsStore.get();
  const wanted =
    state.status === 'idle' || (state.status === 'error' && Date.now() - state.at > RETRY_AFTER_MS);
  if (!wanted || loadScheduled) return;
  loadScheduled = true;
  queueMicrotask(() => {
    loadScheduled = false;
    void refreshToolAssets();
  });
}

const MISSING_REFRESH_MIN_MS = 10_000;
let lastMissingRefresh = 0;

/**
 * A tool of the user's library is on the wall but the loaded index does not have it (it was created or edited after the index
 * was read): loads the index again, at most once in a while so a deleted tool does not make every render fetch.
 */
export function noteMissingToolModel(): void {
  const now = Date.now();
  if (now - lastMissingRefresh < MISSING_REFRESH_MIN_MS) return;
  lastMissingRefresh = now;
  queueMicrotask(() => void refreshToolAssets({ force: true }));
}

/** Generator entry for a bank tool class: the class itself, else the first coarser class that has one. */
export function entryForBankClass(
  state: ToolAssetsState,
  toolClass: string,
  broader: readonly string[],
): ToolAssetEntry | undefined {
  if (state.status !== 'ready') return undefined;
  for (const id of [toolClass, ...broader]) {
    const entry = state.byBankClass.get(id);
    if (entry) return entry;
  }
  return undefined;
}

/** Entry of a generator class by its id (`screwdriver`), or of a user tool by its id. */
export function entryForSource(
  state: ToolAssetsState,
  source: { readonly kind: 'class' | 'tool'; readonly id: string },
): ToolAssetEntry | undefined {
  return state.status === 'ready' ? state.byId.get(`${source.kind}:${source.id}`) : undefined;
}
