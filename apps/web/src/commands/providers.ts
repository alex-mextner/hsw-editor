/**
 * Palette sources beyond the engine's built-in commands and settings: walls, wall items, bank
 * elements and tools, history entries, help pages and go-to targets. Everything the app owns is
 * passed in, so the sources run (and are tested) without the scene, the network or the DOM.
 */
import type { BankElement, BankIndex, ToolClass } from '@hsw-editor/bank';
import type { LocalizedText, PaletteItem, PaletteProvider } from '@hsw-editor/commands';
import type { ChangeEntry, HistoryEntry, WallItem, WallSummary } from '@hsw-editor/core';
import { describeOp } from '@/features/timeline/describeOp.ts';
import type { MessageKey } from '@/i18n/index.ts';
import type { PanelKey } from './editorCommands.ts';
import { undoTargets } from './historyUndo.ts';
import { msg } from './messages.ts';

export interface WallListSnapshot {
  readonly status: 'loading' | 'ready' | 'error';
  readonly walls: readonly WallSummary[];
}

export type BankSnapshot =
  | { readonly status: 'ready'; readonly index: BankIndex }
  | { readonly status: 'loading' | 'error' };

export interface ProviderDeps {
  readonly walls: () => WallListSnapshot;
  readonly openWall: (id: string) => void;
  readonly currentWallId: () => string | null;
  /** Revision of the open wall; part of the history cache key. */
  readonly currentRev: () => number;
  /** Edits of this tab the server has not confirmed yet; undo-to is not offered while any exist. */
  readonly pendingEdits: () => number;
  readonly wallItems: () => readonly WallItem[];
  readonly selectItem: (id: string) => void;
  readonly bank: () => BankSnapshot;
  readonly thumbnailUrl: (element: BankElement) => string;
  readonly addBankElement: (element: BankElement) => void;
  readonly addToolPreset: (toolClass: ToolClass) => void;
  /** The newest slice of the wall's history, ending at `currentRev`. */
  readonly loadHistory: (wallId: string, currentRev: number) => Promise<readonly HistoryEntry[]>;
  readonly undoToRevision: (rev: number) => Promise<void>;
  readonly focusPanel: (panel: PanelKey) => void;
  readonly openCheatSheet: () => void;
  readonly openKeybindingEditor: () => void;
  readonly openDocs: (url: string) => void;
}

export const HOTKEYS_DOC_URL =
  'https://github.com/alex-mextner/hsw-editor/blob/main/docs/hotkeys.md';
const HISTORY_ROWS = 40;

export function wallsProvider(deps: ProviderDeps): PaletteProvider {
  return {
    id: 'walls',
    modes: ['all', 'goto'],
    items: () => {
      const { status, walls } = deps.walls();
      // Offline with nothing cached: the engine reports the source as unavailable.
      if (status === 'error' && walls.length === 0) throw new Error('wall list unavailable');
      return walls.map((wall): PaletteItem => ({
        id: `wall:${wall.id}`,
        kind: 'wall',
        title: wall.name,
        subtitle: msg('palette.wallMeta', { items: wall.items, rev: wall.rev }),
        keywords: [wall.id],
        run: () => deps.openWall(wall.id),
      }));
    },
  };
}

function itemTitle(item: WallItem, bank: BankSnapshot): PaletteItem['title'] {
  if (item.label !== undefined && item.label !== '') return item.label;
  if (bank.status === 'ready') {
    const element = bank.index.elements.find((candidate) => candidate.id === item.bankId);
    if (element !== undefined) return element.name;
    const toolClass = bank.index.toolClasses.find((candidate) => candidate.id === item.toolClass);
    if (toolClass !== undefined) return toolClass.name;
  }
  return msg('palette.wallItem', { id: item.id });
}

export function wallItemsProvider(deps: ProviderDeps): PaletteProvider {
  return {
    id: 'items',
    modes: ['all', 'items'],
    items: () => {
      const bank = deps.bank();
      return deps.wallItems().map((item): PaletteItem => ({
        id: `item:${item.id}`,
        kind: 'item',
        title: itemTitle(item, bank),
        keywords: [item.id, item.kind, item.toolClass ?? '', item.bankId ?? ''].filter(
          (word) => word !== '',
        ),
        run: () => deps.selectItem(item.id),
      }));
    },
  };
}

function bankItems(index: BankIndex, deps: ProviderDeps): readonly PaletteItem[] {
  const toolClassById = new Map(index.toolClasses.map((entry) => [entry.id, entry] as const));
  const elements = index.elements.map((element): PaletteItem => {
    const synonyms = element.toolClasses.flatMap((id) => {
      const toolClass = toolClassById.get(id);
      return toolClass === undefined
        ? []
        : [
            toolClass.name.en,
            toolClass.name.ru,
            ...toolClass.synonyms.en,
            ...toolClass.synonyms.ru,
          ];
    });
    return {
      id: `bank:${element.id}`,
      kind: 'bank',
      title: element.name,
      ...(element.variantLabel === undefined ? {} : { subtitle: element.variantLabel }),
      keywords: [...element.tags.en, ...element.tags.ru, ...synonyms, element.id],
      preview: { kind: 'thumbnail', src: deps.thumbnailUrl(element), alt: element.name },
      run: () => deps.addBankElement(element),
    };
  });
  const tools = index.toolClasses.map((toolClass): PaletteItem => ({
    id: `tool:${toolClass.id}`,
    kind: 'tool',
    title: toolClass.name,
    subtitle: msg('palette.toolPreset'),
    keywords: [...toolClass.synonyms.en, ...toolClass.synonyms.ru, toolClass.id],
    preview: { kind: 'text', title: toolClass.name, body: msg('palette.toolPreset') },
    run: () => deps.addToolPreset(toolClass),
  }));
  return [...tools, ...elements];
}

/** Built once per bank index: the index has hundreds of elements and does not change while open. */
export function bankProvider(deps: ProviderDeps): PaletteProvider {
  let cached: { readonly index: BankIndex; readonly items: readonly PaletteItem[] } | null = null;
  return {
    id: 'bank',
    modes: ['all', 'bank'],
    items: () => {
      const bank = deps.bank();
      if (bank.status === 'error') throw new Error('bank index unavailable');
      if (bank.status !== 'ready') return [];
      if (cached?.index !== bank.index)
        cached = { index: bank.index, items: bankItems(bank.index, deps) };
      return cached.items;
    },
  };
}

function historyTitle(entry: ChangeEntry): LocalizedText {
  const what: LocalizedText =
    entry.label === undefined
      ? msg(describeOp(entry.op).key)
      : { en: entry.label, ru: entry.label };
  return {
    en: msg('palette.historyEntry', { rev: entry.rev, what: what.en }).en,
    ru: msg('palette.historyEntry', { rev: entry.rev, what: what.ru }).ru,
  };
}

function isChange(entry: HistoryEntry): entry is ChangeEntry {
  return entry.kind !== 'create';
}

/**
 * Recent edits that "undo to here" can reach. The history is fetched once per wall revision and
 * shared by both sources: the mixed search asks only once the user typed something, the `:` mode
 * always lists it.
 */
export function historyProviders(deps: ProviderDeps): readonly PaletteProvider[] {
  let cached: { readonly key: string; readonly entries: Promise<readonly HistoryEntry[]> } | null =
    null;
  const load = async (): Promise<readonly PaletteItem[]> => {
    const wallId = deps.currentWallId();
    if (wallId === null || deps.pendingEdits() > 0) return [];
    const key = `${wallId}@${deps.currentRev()}`;
    if (cached?.key !== key) cached = { key, entries: deps.loadHistory(wallId, deps.currentRev()) };
    const entries = await cached.entries.catch((error: unknown) => {
      cached = null;
      throw error;
    });
    const byRev = new Map(entries.filter(isChange).map((entry) => [entry.rev, entry] as const));
    return undoTargets(entries, HISTORY_ROWS).flatMap((rev): PaletteItem[] => {
      const entry = byRev.get(rev);
      if (entry === undefined) return [];
      return [
        {
          id: `history:${wallId}:${rev}`,
          kind: 'history',
          title: historyTitle(entry),
          subtitle: msg('palette.undoTo'),
          keywords: [String(rev), `rev ${rev}`],
          run: () => deps.undoToRevision(rev),
        },
      ];
    });
  };
  return [
    {
      id: 'history',
      modes: ['all'],
      items: (query) => (query.text === '' ? [] : load()),
    },
    { id: 'history-goto', modes: ['goto'], items: load },
  ];
}

interface DocRow {
  readonly id: string;
  readonly title: MessageKey;
  readonly body: MessageKey;
  readonly keywords: readonly string[];
}

const DOCS: readonly DocRow[] = [
  {
    id: 'cheatsheet',
    title: 'help.cheatsheet',
    body: 'help.cheatsheetDescription',
    keywords: ['hotkeys', 'shortcuts', 'keys', 'горячие клавиши', 'клавиши', 'шпаргалка'],
  },
  {
    id: 'palette',
    title: 'help.palette',
    body: 'help.paletteBody',
    keywords: ['command palette', 'search', 'палитра', 'поиск', 'команды', 'режимы'],
  },
  {
    id: 'keybindings',
    title: 'help.keybindings',
    body: 'help.keybindingsBody',
    keywords: ['rebind', 'customise', 'настроить', 'переназначить', 'сочетания'],
  },
  {
    id: 'docs-hotkeys',
    title: 'help.docsHotkeys',
    body: 'help.docsHotkeysBody',
    keywords: ['documentation', 'docs', 'документация', 'справка', 'hotkeys.md'],
  },
];

export function docsProvider(
  deps: ProviderDeps,
  showText: (text: LocalizedText) => void,
): PaletteProvider {
  const runners: Readonly<Record<string, () => void>> = {
    cheatsheet: deps.openCheatSheet,
    palette: () => showText(msg('help.paletteBody')),
    keybindings: deps.openKeybindingEditor,
    'docs-hotkeys': () => deps.openDocs(HOTKEYS_DOC_URL),
  };
  return {
    id: 'docs',
    modes: ['all', 'commands'],
    items: () =>
      DOCS.flatMap((doc): PaletteItem[] => {
        const run = runners[doc.id];
        if (run === undefined) return [];
        return [
          {
            id: `doc:${doc.id}`,
            kind: 'doc',
            title: msg(doc.title),
            subtitle: msg(doc.body),
            keywords: ['help', 'справка', ...doc.keywords],
            preview: { kind: 'text', title: msg(doc.title), body: msg(doc.body) },
            run,
          },
        ];
      }),
  };
}

const PANELS: readonly { readonly panel: PanelKey; readonly title: MessageKey }[] = [
  { panel: 'bank', title: 'cmd.panel.show.bank' },
  { panel: 'inspector', title: 'cmd.panel.show.inspector' },
  { panel: 'history', title: 'cmd.panel.show.history' },
  { panel: 'agent', title: 'cmd.panel.show.agent' },
];

/** `:` mode: panels and a typed revision number (`:12`); walls and history entries come from their own sources. */
export function gotoProvider(deps: ProviderDeps): PaletteProvider {
  return {
    id: 'goto',
    modes: ['goto'],
    items: (query) => {
      const panels = PANELS.map(({ panel, title }): PaletteItem => ({
        id: `goto:panel:${panel}`,
        kind: 'goto',
        title: msg(title),
        keywords: [panel],
        run: () => deps.focusPanel(panel),
      }));
      const revision = /^#?(\d+)$/.exec(query.text);
      const rev = revision?.[1];
      if (rev === undefined) return panels;
      return [
        {
          id: `goto:rev:${rev}`,
          kind: 'goto',
          title: msg('palette.gotoRevision', { rev }),
          subtitle: msg('palette.gotoRevisionHint'),
          keywords: [rev],
          run: () => deps.undoToRevision(Number(rev)),
        },
        ...panels,
      ];
    },
  };
}
