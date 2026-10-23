/**
 * Pure model of the Tool Library panel: built-in classes and the user's tools as one list of entries,
 * grouped by type (the class family), searched in ru/en and filtered by tag. No React, no network.
 */
import MiniSearch from 'minisearch';
import { normalizeTerm } from '@/bank/search.ts';
import type { Locale } from '@/i18n/index.ts';
import type { Label, ToolClassInfo, ToolSummary } from './api.ts';
import { toolRoutes } from './api.ts';

export interface Dims3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface LibraryEntry {
  /** `class:<id>` for a built-in class, `tool:<id>` for a user tool. */
  readonly key: string;
  readonly kind: 'class' | 'tool';
  readonly id: string;
  readonly name: Label;
  /** Family id of the class; `other` for a generic loft that belongs to no class. */
  readonly group: string;
  readonly classId: string | null;
  /** Bank tool-class id: the vocabulary of holder `fitsTool`. */
  readonly bankClass: string | null;
  /** Width, length, thickness in mm. */
  readonly dimsMm: Dims3;
  readonly holdingDims: Readonly<Record<string, number>>;
  readonly tags: readonly string[];
  readonly thumbUrl: string;
  /** Extra words that find the entry (keywords, family and class names). */
  readonly keywords: readonly string[];
  /** Number of ready-made presets (built-in classes only). */
  readonly presets: number;
  readonly updatedAt: string;
}

export interface LibraryGroup {
  readonly id: string;
  readonly label: Label;
  readonly entries: readonly LibraryEntry[];
}

export const OTHER_GROUP = 'other';
export const OTHER_LABEL: Label = { en: 'Other objects', ru: 'Прочие предметы' };

/** Name to show: the requested locale, else the other one, else the id. */
export function entryName(entry: Pick<LibraryEntry, 'name' | 'id'>, locale: Locale): string {
  return entry.name[locale] || entry.name[locale === 'ru' ? 'en' : 'ru'] || entry.id;
}

function toolName(tool: ToolSummary, byClass: ReadonlyMap<string, ToolClassInfo>): Label {
  const cls = tool.classId === null ? undefined : byClass.get(tool.classId);
  return {
    en: tool.name.en ?? tool.name.ru ?? cls?.name.en ?? tool.id,
    ru: tool.name.ru ?? tool.name.en ?? cls?.name.ru ?? tool.id,
  };
}

export function buildEntries(
  classes: readonly ToolClassInfo[],
  tools: readonly ToolSummary[],
): LibraryEntry[] {
  const byClass = new Map(classes.map((cls) => [cls.id, cls] as const));
  const builtIn = classes.map((cls): LibraryEntry => ({
    key: `class:${cls.id}`,
    kind: 'class',
    id: cls.id,
    name: cls.name,
    group: cls.family,
    classId: cls.id,
    bankClass: cls.bankClass,
    dimsMm: cls.dimsMm,
    holdingDims: cls.holdingDims,
    tags: [],
    thumbUrl: toolRoutes.classThumb(cls.id),
    keywords: [...cls.keywords.en, ...cls.keywords.ru, cls.familyLabel.en, cls.familyLabel.ru],
    presets: cls.presets.length,
    updatedAt: '',
  }));
  const mine = tools.map((tool): LibraryEntry => {
    const cls = tool.classId === null ? undefined : byClass.get(tool.classId);
    return {
      key: `tool:${tool.id}`,
      kind: 'tool',
      id: tool.id,
      name: toolName(tool, byClass),
      group: cls?.family ?? OTHER_GROUP,
      classId: tool.classId,
      bankClass: tool.bankClass,
      dimsMm: tool.dimsMm,
      holdingDims: tool.holdingDims,
      tags: tool.tags,
      thumbUrl: toolRoutes.toolThumb(tool.id, tool.updatedAt),
      keywords: cls ? [cls.name.en, cls.name.ru, ...cls.keywords.en, ...cls.keywords.ru] : [],
      presets: 0,
      updatedAt: tool.updatedAt,
    };
  });
  return [...mine, ...builtIn];
}

export interface LibraryQuery {
  readonly text: string;
  /** Selected tags; an entry must carry all of them. */
  readonly tags: readonly string[];
  /** Only the user's own tools. */
  readonly mineOnly: boolean;
}

export const NO_QUERY: LibraryQuery = { text: '', tags: [], mineOnly: false };

interface Doc {
  readonly id: string;
  readonly nameRu: string;
  readonly nameEn: string;
  readonly keywords: string;
  readonly tags: string;
}

/** Ranked search over names (weighed most), keywords and tags; ru and en, ё = е, prefixes and typos. */
export function createLibrarySearch(
  entries: readonly LibraryEntry[],
): (text: string) => ReadonlySet<string> | null {
  const engine = new MiniSearch<Doc>({
    fields: ['nameRu', 'nameEn', 'keywords', 'tags'],
    idField: 'id',
    processTerm: (term) => normalizeTerm(term),
    tokenize: (text) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean),
    searchOptions: {
      boost: { nameRu: 4, nameEn: 4, tags: 2 },
      prefix: true,
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      combineWith: 'AND',
    },
  });
  engine.addAll(
    entries.map((entry) => ({
      id: entry.key,
      nameRu: entry.name.ru,
      nameEn: entry.name.en,
      keywords: entry.keywords.join(' '),
      tags: entry.tags.join(' '),
    })),
  );
  return (text) => {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    return new Set(engine.search(trimmed).map((hit) => String(hit.id)));
  };
}

export function filterEntries(
  entries: readonly LibraryEntry[],
  query: LibraryQuery,
  search: (text: string) => ReadonlySet<string> | null,
): LibraryEntry[] {
  const hits = search(query.text);
  return entries.filter(
    (entry) =>
      (hits === null || hits.has(entry.key)) &&
      (!query.mineOnly || entry.kind === 'tool') &&
      query.tags.every((tag) => entry.tags.includes(tag)),
  );
}

/** Tags in use on the user's tools with their counts, most used first (then alphabetical). */
export function tagCounts(entries: readonly LibraryEntry[]): Array<readonly [string, number]> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Entries by family in the registry order of `classes`; the user's tools come first inside a group. */
export function groupEntries(
  entries: readonly LibraryEntry[],
  classes: readonly ToolClassInfo[],
): LibraryGroup[] {
  const order: Array<{ id: string; label: Label }> = [];
  for (const cls of classes) {
    if (!order.some((group) => group.id === cls.family)) {
      order.push({ id: cls.family, label: cls.familyLabel });
    }
  }
  order.push({ id: OTHER_GROUP, label: OTHER_LABEL });
  return order
    .map((group) => ({
      ...group,
      entries: entries.filter((entry) => entry.group === group.id),
    }))
    .filter((group) => group.entries.length > 0);
}
