/**
 * State of the Tool Library: the loaded classes and user tools (server data) and the panel's view state
 * (query, collapsed groups, which page is open). Module-level so the panel survives left-panel tab switches.
 */
import { createValueStore } from '#state-backend';
import { createPersistedStore } from '@/state/persisted.ts';
import { NetworkError } from '@/api/http.ts';
import { refreshToolAssets } from '@/toolmodels/assets.ts';
import { fetchClasses, fetchTools, type ToolClassInfo, type ToolSummary } from './api.ts';
import { NO_QUERY, type LibraryQuery } from './model.ts';

export type LibraryState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string; readonly offline: boolean }
  | {
      readonly status: 'ready';
      readonly classes: readonly ToolClassInfo[];
      readonly tools: readonly ToolSummary[];
    };

export const libraryStore = createValueStore<LibraryState>({ status: 'loading' });

let inflight: Promise<void> | null = null;

function load(): Promise<void> {
  return Promise.all([fetchClasses(), fetchTools()])
    .then(([classes, tools]) => libraryStore.set({ status: 'ready', classes, tools }))
    .catch((error: unknown) => {
      // A library that was loaded stays usable when a later refresh fails.
      if (libraryStore.get().status === 'ready') return;
      libraryStore.set({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        offline: error instanceof NetworkError,
      });
    });
}

/**
 * Loads (or reloads) classes and the user library. Concurrent plain calls share one request; `fresh` (after the caller
 * changed the library) waits for the running request and then loads again, so the answer includes the change.
 */
export function refreshToolLibrary(fresh = false): Promise<void> {
  if (inflight !== null && !fresh) return inflight;
  const run = inflight === null ? load() : inflight.then(load);
  const tracked = run.finally(() => {
    if (inflight === tracked) inflight = null;
    // The library changed: the tool models on the wall come from an index that has to know its newest tool.
    if (fresh) void refreshToolAssets({ force: true });
  });
  inflight = tracked;
  return tracked;
}

/** Page shown in the panel body. */
export type ToolsView =
  | { readonly page: 'list' }
  | { readonly page: 'detail'; readonly entryKey: string };

export interface ToolsPanelState {
  readonly query: LibraryQuery;
  /** Group ids the user collapsed. */
  readonly collapsed: readonly string[];
  readonly view: ToolsView;
  /** The "Add from photo" wizard is open. */
  readonly wizardOpen: boolean;
}

/** Search text, tags and collapsed groups survive reloads; the open page and the wizard do not. */
interface PersistedPanel {
  readonly query: LibraryQuery;
  readonly collapsed: readonly string[];
}

function parsePersisted(raw: string): PersistedPanel | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const query = 'query' in value ? value.query : undefined;
    const collapsed = 'collapsed' in value ? value.collapsed : undefined;
    if (typeof query !== 'object' || query === null) return null;
    const text = 'text' in query && typeof query.text === 'string' ? query.text : '';
    const tags =
      'tags' in query && Array.isArray(query.tags)
        ? query.tags.filter((tag): tag is string => typeof tag === 'string')
        : [];
    const mineOnly = 'mineOnly' in query && query.mineOnly === true;
    return {
      query: { text, tags, mineOnly },
      collapsed: Array.isArray(collapsed)
        ? collapsed.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return null;
  }
}

const persistedStore = createPersistedStore<PersistedPanel>(
  'hsw.tools.panel',
  { query: NO_QUERY, collapsed: [] },
  parsePersisted,
);

export const toolsPanelStore = createValueStore<ToolsPanelState>({
  ...persistedStore.get(),
  view: { page: 'list' },
  wizardOpen: false,
});

export function patchToolsPanel(patch: Partial<ToolsPanelState>): void {
  const next = { ...toolsPanelStore.get(), ...patch };
  toolsPanelStore.set(next);
  persistedStore.set({ query: next.query, collapsed: next.collapsed });
}

export function patchToolsQuery(patch: Partial<LibraryQuery>): void {
  patchToolsPanel({ query: { ...toolsPanelStore.get().query, ...patch } });
}

export function toggleToolsTag(tag: string): void {
  const { tags } = toolsPanelStore.get().query;
  patchToolsQuery({
    tags: tags.includes(tag) ? tags.filter((entry) => entry !== tag) : [...tags, tag],
  });
}

export function toggleToolsGroup(groupId: string): void {
  const { collapsed } = toolsPanelStore.get();
  patchToolsPanel({
    collapsed: collapsed.includes(groupId)
      ? collapsed.filter((id) => id !== groupId)
      : [...collapsed, groupId],
  });
}

export function openToolDetail(entryKey: string): void {
  patchToolsPanel({ view: { page: 'detail', entryKey } });
}

export function closeToolDetail(): void {
  patchToolsPanel({ view: { page: 'list' } });
}

export function openPhotoWizard(): void {
  patchToolsPanel({ wizardOpen: true });
}

export function closePhotoWizard(): void {
  patchToolsPanel({ wizardOpen: false });
}
