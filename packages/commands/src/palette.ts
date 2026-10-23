/**
 * Palette engine: prefix modes, providers, fuzzy ranking with frecency. Pure and synchronous
 * apart from provider calls, so it runs offline and is fully testable without a DOM.
 *
 * Items come from providers (commands, settings, walls, wall items, bank elements and tools,
 * history entries, docs, go-to targets); the app registers the providers, this module ranks them.
 */
import { formatChord } from './keys.ts';
import { bindingsOf, type Keymap } from './keymap.ts';
import { compileQuery, matchQuery, type SearchField } from './fuzzy.ts';
import { COMMAND_GROUPS, type Command, type CommandRegistry } from './registry.ts';
import { SETTING_GROUPS, type SettingsStore, type SettingValue } from './settings.ts';
import { type Label, labelText, labelVariants, type Locale, type LocalizedText } from './text.ts';
import { frecencyBoost, recentIds, type UsageRecord } from './usage.ts';
import type { Context } from './when.ts';

export type PaletteKind =
  | 'recent'
  | 'command'
  | 'setting'
  | 'wall'
  | 'item'
  | 'bank'
  | 'tool'
  | 'history'
  | 'doc'
  | 'goto'
  | 'ai';

export type PaletteMode = 'all' | 'commands' | 'items' | 'bank' | 'goto' | 'ai';

export const MODE_PREFIXES: Readonly<Record<string, PaletteMode>> = {
  '>': 'commands',
  '@': 'items',
  '#': 'bank',
  ':': 'goto',
  '?': 'ai',
};

export interface ParsedInput {
  readonly mode: PaletteMode;
  /** The prefix character that selected the mode, or ''. */
  readonly prefix: string;
  readonly text: string;
}

export function parsePaletteInput(raw: string): ParsedInput {
  const first = raw.charAt(0);
  const mode = MODE_PREFIXES[first];
  if (mode === undefined) return { mode: 'all', prefix: '', text: raw.trim() };
  return { mode, prefix: first, text: raw.slice(1).trim() };
}

export type PalettePreview =
  | { readonly kind: 'thumbnail'; readonly src: string; readonly alt: Label }
  | { readonly kind: 'text'; readonly title: Label; readonly body: Label };

export type PaletteControl =
  | { readonly type: 'switch'; readonly checked: boolean }
  | {
      readonly type: 'choice';
      readonly value: string;
      readonly options: readonly { readonly value: string; readonly label: Label }[];
    }
  | {
      readonly type: 'number';
      readonly value: number;
      readonly min: number;
      readonly max: number;
      readonly step: number;
    };

export interface PaletteAction {
  readonly id: string;
  readonly title: Label;
  readonly run: () => void | Promise<void>;
}

export interface PaletteItem {
  /** Unique across providers and stable between runs (recents are keyed by it): `cmd:edit.undo`. */
  readonly id: string;
  readonly kind: PaletteKind;
  readonly title: Label;
  readonly subtitle?: Label;
  readonly group?: Label;
  /** Synonyms matched by the search but not shown. */
  readonly keywords?: readonly string[];
  /** Display text of the first key binding, already formatted for the platform. */
  readonly keybinding?: string;
  readonly preview?: PalettePreview;
  /** Inline editor of a setting; Enter on such an item without `run` focuses it. */
  readonly control?: PaletteControl;
  /** Enter. Absent when the item is only an inline control. */
  readonly run?: () => void | Promise<void>;
  /** Extra actions: add to wall, show details. */
  readonly secondary?: readonly PaletteAction[];
}

export interface ProviderQuery {
  readonly text: string;
  readonly locale: Locale;
  readonly context: Context;
  readonly signal?: AbortSignal;
}

export interface PaletteProvider {
  readonly id: string;
  /** Modes this provider answers in; `all` is the default mixed mode. */
  readonly modes: readonly PaletteMode[];
  /** Candidate items; the engine does the fuzzy ranking. */
  readonly items: (
    query: ProviderQuery,
  ) => readonly PaletteItem[] | Promise<readonly PaletteItem[]>;
}

export interface RankedItem {
  readonly item: PaletteItem;
  readonly score: number;
  /** Matched indexes in the item's displayed title, for highlighting. */
  readonly positions: readonly number[];
}

export interface PaletteSection {
  readonly kind: PaletteKind;
  readonly title: LocalizedText;
  readonly items: readonly RankedItem[];
}

export interface PaletteResults {
  readonly mode: PaletteMode;
  readonly text: string;
  readonly sections: readonly PaletteSection[];
  /** Every row in display order, for keyboard navigation. */
  readonly rows: readonly RankedItem[];
  /** Providers that threw or rejected; the others' results are still shown. */
  readonly failedProviders: readonly string[];
}

export interface PaletteSearchOptions {
  readonly input: string;
  readonly providers: readonly PaletteProvider[];
  readonly locale: Locale;
  readonly context: Context;
  readonly usage: UsageRecord;
  readonly now: number;
  /** Sends free text to the AI. Without it the "Ask AI" row is not offered. */
  readonly askAi?: (text: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
  /** Rows per section in the mixed mode (default 8). */
  readonly perSection?: number;
  /** Rows in a single-purpose mode (default 100). */
  readonly limit?: number;
}

const SECTION_TITLES: Readonly<Record<PaletteKind, LocalizedText>> = {
  recent: { en: 'Recent', ru: 'Недавние' },
  command: { en: 'Commands', ru: 'Команды' },
  setting: { en: 'Settings', ru: 'Настройки' },
  wall: { en: 'Walls', ru: 'Стены' },
  item: { en: 'On the wall', ru: 'На стене' },
  bank: { en: 'Bank', ru: 'Банк' },
  tool: { en: 'Tools', ru: 'Инструменты' },
  history: { en: 'History', ru: 'История' },
  doc: { en: 'Help', ru: 'Справка' },
  goto: { en: 'Go to', ru: 'Перейти' },
  ai: { en: 'Ask AI', ru: 'Спросить ИИ' },
};

/** Kinds the user usually means first; breaks near-ties without outranking a clearly better match. */
const KIND_PRIOR: Readonly<Record<PaletteKind, number>> = {
  recent: 0,
  command: 4,
  setting: 3,
  goto: 2,
  wall: 1,
  item: 1,
  bank: 0,
  tool: 0,
  history: 0,
  doc: 0,
  ai: 0,
};

const DEFAULT_PER_SECTION = 8;
const DEFAULT_LIMIT = 100;
const RECENT_ROWS = 6;

function fieldsOf(item: PaletteItem, locale: Locale): readonly SearchField[] {
  const other: Locale = locale === 'en' ? 'ru' : 'en';
  const title = item.title;
  const fields: SearchField[] = [{ text: labelText(title, locale), weight: 1 }];
  if (typeof title !== 'string') fields.push({ text: title[other], weight: 0.95 });
  for (const keyword of item.keywords ?? []) fields.push({ text: keyword, weight: 0.8 });
  if (item.subtitle !== undefined) {
    for (const text of labelVariants(item.subtitle)) fields.push({ text, weight: 0.35 });
  }
  if (item.group !== undefined) {
    for (const text of labelVariants(item.group)) fields.push({ text, weight: 0.3 });
  }
  return fields;
}

export interface RankOptions {
  readonly locale: Locale;
  readonly usage: UsageRecord;
  readonly now: number;
}

/** Fuzzy-ranks items against `text` (empty text keeps everything, ordered by frecency and title). */
export function rankPaletteItems(
  items: readonly PaletteItem[],
  text: string,
  options: RankOptions,
): readonly RankedItem[] {
  const ranked: RankedItem[] = [];
  const query = compileQuery(text);
  for (const item of items) {
    const match = matchQuery(query, fieldsOf(item, options.locale));
    if (match === null) continue;
    const score =
      match.score + KIND_PRIOR[item.kind] + frecencyBoost(options.usage[item.id], options.now);
    ranked.push({ item, score, positions: match.positions });
  }
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      labelText(a.item.title, options.locale).localeCompare(
        labelText(b.item.title, options.locale),
      ),
  );
}

export async function searchPalette(options: PaletteSearchOptions): Promise<PaletteResults> {
  const parsed = parsePaletteInput(options.input);
  const { mode, text } = parsed;
  const perSection = options.perSection ?? DEFAULT_PER_SECTION;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const askRow = askAiRow(text, options);

  const active = options.providers.filter((provider) => provider.modes.includes(mode));
  const query: ProviderQuery = {
    text,
    locale: options.locale,
    context: options.context,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const settled =
    mode === 'ai'
      ? []
      : await Promise.allSettled(active.map(async (provider) => provider.items(query)));
  const failedProviders = active
    .filter((_, index) => settled[index]?.status === 'rejected')
    .map((provider) => provider.id);
  const lists = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const seen = new Set<string>();
  const items = lists.flat().filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  const sections: PaletteSection[] = [];
  if (mode === 'ai') {
    if (askRow !== null) sections.push(section('ai', [askRow]));
  } else if (mode !== 'all') {
    const ranked = rankPaletteItems(items, text, options).slice(0, limit);
    for (const kind of new Set(ranked.map((entry) => entry.item.kind))) {
      sections.push(
        section(
          kind,
          ranked.filter((entry) => entry.item.kind === kind),
        ),
      );
    }
  } else {
    sections.push(...mixedSections(items, text, options, perSection));
    if (askRow !== null) sections.push(section('ai', [askRow]));
  }
  const rows = sections.flatMap((entry) => entry.items);
  return { mode, text, sections, rows, failedProviders };
}

function section(kind: PaletteKind, items: readonly RankedItem[]): PaletteSection {
  return { kind, title: SECTION_TITLES[kind], items };
}

function mixedSections(
  items: readonly PaletteItem[],
  text: string,
  options: PaletteSearchOptions,
  perSection: number,
): readonly PaletteSection[] {
  if (text === '') {
    // Empty query: what the user used lately, then the commands they are most likely to want.
    const byId = new Map(items.map((item) => [item.id, item] as const));
    const recent = recentIds(options.usage, options.now, RECENT_ROWS)
      .map((id) => byId.get(id))
      .filter((item): item is PaletteItem => item !== undefined)
      .map((item): RankedItem => ({ item, score: 0, positions: [] }));
    const recentIdSet = new Set(recent.map((entry) => entry.item.id));
    const rest = rankPaletteItems(
      items.filter((item) => item.kind === 'command' && !recentIdSet.has(item.id)),
      '',
      options,
    ).slice(0, perSection);
    return [
      ...(recent.length > 0 ? [section('recent', recent)] : []),
      ...(rest.length > 0 ? [section('command', rest)] : []),
    ];
  }
  const ranked = rankPaletteItems(items, text, options);
  const byKind = new Map<PaletteKind, RankedItem[]>();
  for (const entry of ranked) {
    const bucket = byKind.get(entry.item.kind) ?? [];
    if (bucket.length < perSection) bucket.push(entry);
    byKind.set(entry.item.kind, bucket);
  }
  return [...byKind.entries()]
    .sort(([, a], [, b]) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0))
    .map(([kind, bucket]) => section(kind, bucket));
}

function askAiRow(text: string, options: PaletteSearchOptions): RankedItem | null {
  const { askAi } = options;
  if (askAi === undefined || text === '') return null;
  const item: PaletteItem = {
    id: 'ai:ask',
    kind: 'ai',
    title: {
      en: `Ask AI: ${text}`,
      ru: `Спросить ИИ: ${text}`,
    },
    run: () => askAi(text),
  };
  return { item, score: 0, positions: [] };
}

// ---- Built-in providers ------------------------------------------------------------------------

export interface CommandProviderDeps {
  readonly registry: CommandRegistry;
  readonly getKeymap: () => Keymap;
  readonly getContext: () => Context;
  /** Called after a command item ran, with its outcome. */
  readonly onRun?: (command: Command, ok: boolean) => void;
}

/** A command can be run from the palette alone when it needs no arguments. */
function runnableWithoutArgs(command: Command): boolean {
  return command.argsSchema === undefined || command.argsSchema.safeParse({}).success;
}

/** The palette row of a command; `run` is added by the caller that can execute it. */
export function commandPaletteItem(command: Command, keymap: Keymap): PaletteItem {
  const binding = bindingsOf(keymap, command.id)[0];
  return {
    id: `cmd:${command.id}`,
    kind: 'command',
    title: command.title,
    ...(command.description === undefined ? {} : { subtitle: command.description }),
    group: COMMAND_GROUPS[command.group],
    keywords: [...(command.keywords ?? []), command.id.replaceAll('.', ' ')],
    ...(binding === undefined ? {} : { keybinding: formatChord(binding.chord, keymap.platform) }),
  };
}

export function commandProvider(deps: CommandProviderDeps): PaletteProvider {
  return {
    id: 'commands',
    modes: ['all', 'commands'],
    items: () => {
      const keymap = deps.getKeymap();
      const context = deps.getContext();
      return deps.registry
        .available(context)
        .filter((command) => command.hidden !== true && runnableWithoutArgs(command))
        .map((command): PaletteItem => ({
          ...commandPaletteItem(command, keymap),
          run: async () => {
            const outcome = await deps.registry.run(command.id, undefined, deps.getContext());
            deps.onRun?.(command, outcome.ok);
          },
        }));
    },
  };
}

function controlOf(store: SettingsStore, id: string): PaletteControl | undefined {
  const definition = store.definition(id);
  if (definition === undefined) return undefined;
  const value = store.get(id);
  switch (definition.type) {
    case 'boolean':
      return { type: 'switch', checked: value === true };
    case 'choice':
      return { type: 'choice', value: String(value), options: definition.options };
    case 'number':
      return {
        type: 'number',
        value: Number(value),
        min: definition.min,
        max: definition.max,
        step: definition.step,
      };
  }
}

function describeValue(store: SettingsStore, id: string, locale: Locale): string {
  const definition = store.definition(id);
  const value: SettingValue = store.get(id);
  if (definition?.type === 'boolean')
    return locale === 'ru' ? (value ? 'вкл' : 'выкл') : value ? 'on' : 'off';
  if (definition?.type === 'choice') {
    const option = definition.options.find((o) => o.value === value);
    return option === undefined ? String(value) : labelText(option.label, locale);
  }
  return String(value);
}

/** Every setting as a searchable, inline-editable item. */
export function settingsProvider(store: SettingsStore, getLocale: () => Locale): PaletteProvider {
  return {
    id: 'settings',
    modes: ['all', 'commands'],
    items: () =>
      store.definitions.map((definition): PaletteItem => {
        const control = controlOf(store, definition.id);
        const locale = getLocale();
        return {
          id: `setting:${definition.id}`,
          kind: 'setting',
          title: definition.title,
          subtitle: {
            en: describeValue(store, definition.id, 'en'),
            ru: describeValue(store, definition.id, 'ru'),
          },
          group: SETTING_GROUPS[definition.group],
          keywords: [
            ...(definition.keywords ?? []),
            ...(definition.description === undefined ? [] : labelVariants(definition.description)),
            definition.id.replaceAll('.', ' '),
            locale === 'ru' ? 'настройки' : 'settings',
          ],
          ...(control === undefined ? {} : { control }),
          ...(definition.type === 'number' ? {} : { run: () => void store.toggle(definition.id) }),
        };
      }),
  };
}
