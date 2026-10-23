import { describe, expect, test } from 'bun:test';
import type { BankElement, BankIndex, ToolClass } from '@hsw-editor/bank';
import {
  EMPTY_USAGE,
  searchPalette,
  type PaletteProvider,
  type PaletteResults,
} from '@hsw-editor/commands';
import type { HistoryEntry, WallItem, WallSummary } from '@hsw-editor/core';
import type { PanelKey } from './editorCommands.ts';
import {
  bankProvider,
  docsProvider,
  gotoProvider,
  historyProviders,
  HOTKEYS_DOC_URL,
  type BankSnapshot,
  type ProviderDeps,
  type WallListSnapshot,
  wallItemsProvider,
  wallsProvider,
} from './providers.ts';

const ACTOR = { kind: 'human', name: 'test' } as const;
const NOOP = { type: 'lock', id: 'i1', locked: true } as const;

function change(kind: 'op' | 'undo', rev: number, label?: string): HistoryEntry {
  return {
    kind,
    rev,
    ts: '2026-10-23T00:00:00Z',
    actor: ACTOR,
    op: NOOP,
    inverse: NOOP,
    ...(label === undefined ? {} : { label }),
  };
}

const wall = (id: string, name: string, items: number, rev: number): WallSummary => ({
  id,
  name,
  items,
  rev,
  photos: 0,
  models: 0,
  updatedAt: '2026-10-23T00:00:00Z',
});

const element = (id: string, ru: string, en: string, tags: string[]): BankElement =>
  ({
    id,
    name: { ru, en },
    tags: { ru: tags, en: [] },
    toolClasses: ['screwdriver'],
    assets: { thumbnail: { path: `thumb/${id}.webp` } },
  }) as unknown as BankElement;

const index = {
  toolClasses: [
    {
      id: 'screwdriver',
      name: { ru: 'Отвёртка', en: 'Screwdriver' },
      synonyms: { ru: ['отвертка'], en: ['driver'] },
    },
  ],
  elements: [element('sd-6', 'Держатель отвёртки', 'Screwdriver holder', ['шлицевая'])],
} as unknown as BankIndex;

const item = (id: string, patch: Partial<WallItem> = {}): WallItem =>
  ({ id, kind: 'holder', locked: false, ...patch }) as unknown as WallItem;

interface Calls {
  readonly opened: string[];
  readonly selected: string[];
  readonly added: string[];
  readonly tools: string[];
  readonly undone: number[];
  readonly panels: PanelKey[];
  readonly docs: string[];
  historyLoads: number;
}

function makeDeps(
  overrides: {
    walls?: WallListSnapshot;
    bank?: BankSnapshot;
    items?: readonly WallItem[];
    history?: () => Promise<readonly HistoryEntry[]>;
    wallId?: string | null;
    pending?: number;
  } = {},
): { deps: ProviderDeps; calls: Calls } {
  const calls: Calls = {
    opened: [],
    selected: [],
    added: [],
    tools: [],
    undone: [],
    panels: [],
    docs: [],
    historyLoads: 0,
  };
  const deps: ProviderDeps = {
    walls: () => overrides.walls ?? { status: 'ready', walls: [] },
    openWall: (id) => calls.opened.push(id),
    currentWallId: () => (overrides.wallId === undefined ? 'w1' : overrides.wallId),
    currentRev: () => 5,
    pendingEdits: () => overrides.pending ?? 0,
    wallItems: () => overrides.items ?? [],
    selectItem: (id) => calls.selected.push(id),
    bank: () => overrides.bank ?? { status: 'ready', index },
    thumbnailUrl: (entry) => `/bank/assets/${entry.assets.thumbnail.path}`,
    addBankElement: (entry) => calls.added.push(entry.id),
    addToolPreset: (toolClass: ToolClass) => calls.tools.push(toolClass.id),
    loadHistory: async () => {
      calls.historyLoads += 1;
      return (
        (await overrides.history?.()) ?? [
          change('op', 1),
          change('op', 2, 'Moved'),
          change('op', 3),
        ]
      );
    },
    undoToRevision: async (rev) => {
      calls.undone.push(rev);
    },
    focusPanel: (panel) => calls.panels.push(panel),
    openCheatSheet: () => calls.docs.push('cheatsheet'),
    openKeybindingEditor: () => calls.docs.push('keybindings'),
    openDocs: (url) => calls.docs.push(url),
  };
  return { deps, calls };
}

function search(input: string, providers: readonly PaletteProvider[]): Promise<PaletteResults> {
  return searchPalette({
    input,
    providers,
    locale: 'en',
    context: {},
    usage: EMPTY_USAGE,
    now: 0,
  });
}

describe('walls', () => {
  const walls: WallListSnapshot = {
    status: 'ready',
    walls: [wall('w1', 'Garage', 12, 7), wall('w2', 'Workshop', 3, 1)],
  };

  test('finds a wall by name and opens it', async () => {
    const { deps, calls } = makeDeps({ walls });
    const results = await search(':work', [wallsProvider(deps)]);
    expect(results.rows.map((row) => row.item.id)).toEqual(['wall:w2']);
    await results.rows[0]?.item.run?.();
    expect(calls.opened).toEqual(['w2']);
  });

  test('an unreachable list with nothing cached is reported, not hidden', async () => {
    const { deps } = makeDeps({ walls: { status: 'error', walls: [] } });
    const results = await search(':', [wallsProvider(deps)]);
    expect(results.failedProviders).toEqual(['walls']);
  });

  test('a stale list is still shown when a refresh failed', async () => {
    const { deps } = makeDeps({ walls: { status: 'error', walls: walls.walls } });
    const results = await search(':garage', [wallsProvider(deps)]);
    expect(results.failedProviders).toEqual([]);
    expect(results.rows).toHaveLength(1);
  });
});

describe('wall items', () => {
  test('titles come from the label, then the bank element, then the tool class', async () => {
    const { deps, calls } = makeDeps({
      items: [
        item('a', { label: 'My driver set' }),
        item('b', { bankId: 'sd-6' }),
        item('c', { toolClass: 'screwdriver' }),
        item('d'),
      ],
    });
    const results = await search('@', [wallItemsProvider(deps)]);
    const titles = results.rows.map((row) => row.item.title);
    expect(titles).toContain('My driver set');
    expect(titles).toContainEqual({ ru: 'Держатель отвёртки', en: 'Screwdriver holder' });
    expect(titles).toContainEqual({ ru: 'Отвёртка', en: 'Screwdriver' });
    await results.rows.find((row) => row.item.id === 'item:a')?.item.run?.();
    expect(calls.selected).toEqual(['a']);
  });
});

describe('bank and tools', () => {
  test('# finds elements through Russian and English names and adds them', async () => {
    const { deps, calls } = makeDeps();
    const provider = bankProvider(deps);
    const ru = await search('#отвертк', [provider]);
    expect(ru.rows.some((row) => row.item.id === 'bank:sd-6')).toBe(true);
    const en = await search('#holder', [provider]);
    const hit = en.rows.find((row) => row.item.id === 'bank:sd-6');
    expect(hit?.item.preview).toEqual({
      kind: 'thumbnail',
      src: '/bank/assets/thumb/sd-6.webp',
      alt: { ru: 'Держатель отвёртки', en: 'Screwdriver holder' },
    });
    await hit?.item.run?.();
    expect(calls.added).toEqual(['sd-6']);
  });

  test('tool classes are added as presets', async () => {
    const { deps, calls } = makeDeps();
    const results = await search('#driver', [bankProvider(deps)]);
    await results.rows.find((row) => row.item.id === 'tool:screwdriver')?.item.run?.();
    expect(calls.tools).toEqual(['screwdriver']);
  });

  test('items are built once per bank index', () => {
    const { deps } = makeDeps();
    const provider = bankProvider(deps);
    const query = { text: '', locale: 'en', context: {} } as const;
    expect(provider.items(query)).toBe(provider.items(query));
  });

  test('a loading bank yields nothing and a failed one is reported', async () => {
    const loading = await search('#x', [
      bankProvider(makeDeps({ bank: { status: 'loading' } }).deps),
    ]);
    expect(loading.failedProviders).toEqual([]);
    const failed = await search('#x', [bankProvider(makeDeps({ bank: { status: 'error' } }).deps)]);
    expect(failed.failedProviders).toEqual(['bank']);
  });
});

describe('history', () => {
  test('the mixed search stays off the network until something is typed', async () => {
    const { deps, calls } = makeDeps();
    await search('', historyProviders(deps));
    expect(calls.historyLoads).toBe(0);
    await search('moved', historyProviders(deps));
    expect(calls.historyLoads).toBe(1);
  });

  test(': lists the edits and undoes back to the chosen one', async () => {
    const { deps, calls } = makeDeps();
    const results = await search(':', historyProviders(deps));
    expect(results.rows.map((row) => row.item.id).sort()).toEqual([
      'history:w1:1',
      'history:w1:2',
      'history:w1:3',
    ]);
    const second = results.rows.find((row) => row.item.id === 'history:w1:2')?.item;
    expect(second?.title).toEqual({ en: '#2 · Moved', ru: '#2 · Moved' });
    await second?.run?.();
    expect(calls.undone).toEqual([2]);
  });

  test('the history is fetched once per wall revision', async () => {
    const { deps, calls } = makeDeps();
    const providers = historyProviders(deps);
    await search(':', providers);
    await search(':2', providers);
    expect(calls.historyLoads).toBe(1);
  });

  test('an unreachable server marks the source failed and is retried next time', async () => {
    let fail = true;
    const { deps, calls } = makeDeps({
      history: async () => {
        if (fail) throw new Error('offline');
        return [change('op', 1)];
      },
    });
    const providers = historyProviders(deps);
    expect((await search(':', providers)).failedProviders).toEqual(['history-goto']);
    fail = false;
    expect((await search(':', providers)).rows).toHaveLength(1);
    expect(calls.historyLoads).toBe(2);
  });

  test('undone edits are not offered', async () => {
    const { deps } = makeDeps({
      history: async () => [change('op', 1), change('op', 2), change('undo', 3)],
    });
    const results = await search(':', historyProviders(deps));
    expect(results.rows.map((row) => row.item.id)).toEqual(['history:w1:1']);
  });

  test('nothing is offered while this tab has unconfirmed edits, and nothing is fetched', async () => {
    const { deps, calls } = makeDeps({ pending: 2 });
    expect((await search(':', historyProviders(deps))).rows).toEqual([]);
    expect(calls.historyLoads).toBe(0);
  });

  test('without an open wall there is no history', async () => {
    const { deps, calls } = makeDeps({ wallId: null });
    expect((await search(':', historyProviders(deps))).rows).toEqual([]);
    expect(calls.historyLoads).toBe(0);
  });
});

describe('go to', () => {
  test(':12 offers revision 12 first', async () => {
    const { deps, calls } = makeDeps();
    const results = await search(':12', [gotoProvider(deps)]);
    const first = results.rows[0]?.item;
    expect(first?.id).toBe('goto:rev:12');
    await first?.run?.();
    expect(calls.undone).toEqual([12]);
  });

  test('panels are listed and focus the panel', async () => {
    const { deps, calls } = makeDeps();
    const results = await search(':inspector', [gotoProvider(deps)]);
    await results.rows.find((row) => row.item.id === 'goto:panel:inspector')?.item.run?.();
    expect(calls.panels).toEqual(['inspector']);
  });
});

describe('help pages', () => {
  test('are searchable in both languages and open their target', async () => {
    const { deps, calls } = makeDeps();
    const provider = docsProvider(deps, () => undefined);
    const en = await search('shortcuts', [provider]);
    expect(en.rows[0]?.item.id).toBe('doc:cheatsheet');
    const ru = await search('шпаргалка', [provider]);
    expect(ru.rows[0]?.item.id).toBe('doc:cheatsheet');
    await ru.rows[0]?.item.run?.();
    const docs = await search('documentation', [provider]);
    await docs.rows.find((row) => row.item.id === 'doc:docs-hotkeys')?.item.run?.();
    expect(calls.docs).toEqual(['cheatsheet', HOTKEYS_DOC_URL]);
  });
});
