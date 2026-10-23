/**
 * Frecency: what the user ran lately and often ranks higher in the palette. The record is a plain
 * JSON object persisted in the user's settings document (namespace `palette`).
 */
import { z } from 'zod';
import { BONUS_EXACT } from './fuzzy.ts';

export interface UsageEntry {
  readonly count: number;
  /** Epoch ms of the last use. */
  readonly lastUsed: number;
}

export type UsageRecord = Readonly<Record<string, UsageEntry>>;

export const EMPTY_USAGE: UsageRecord = {};

export const MAX_USAGE_ENTRIES = 400;

const FRECENCY_WEIGHT = 5;
const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** Stays below the exact-title bonus so history never outranks a clearly better text match. */
export const MAX_BOOST = Math.floor(BONUS_EXACT * 0.45);

export function frecencyBoost(entry: UsageEntry | undefined, now: number): number {
  if (entry === undefined) return 0;
  const age = Math.max(0, now - entry.lastUsed);
  const boost = FRECENCY_WEIGHT * Math.log1p(entry.count) * 0.5 ** (age / HALF_LIFE_MS);
  return Math.min(MAX_BOOST, boost);
}

/** Records one use; the least valuable entries are dropped past {@link MAX_USAGE_ENTRIES}. */
export function recordUse(usage: UsageRecord, id: string, now: number): UsageRecord {
  const previous = usage[id];
  const next: Record<string, UsageEntry> = {
    ...usage,
    [id]: { count: (previous?.count ?? 0) + 1, lastUsed: now },
  };
  const ids = Object.keys(next);
  if (ids.length <= MAX_USAGE_ENTRIES) return next;
  // The entry just recorded is never the one to go: it would never get to build up a score.
  const candidates = ids.filter((other) => other !== id);
  candidates.sort((a, b) => frecencyBoost(next[a], now) - frecencyBoost(next[b], now));
  for (const stale of candidates.slice(0, ids.length - MAX_USAGE_ENTRIES)) delete next[stale];
  return next;
}

/** Ids by descending frecency: the "recent" list of an empty query. */
export function recentIds(usage: UsageRecord, now: number, limit: number): readonly string[] {
  return Object.entries(usage)
    .map(([id, entry]) => ({ id, boost: frecencyBoost(entry, now), lastUsed: entry.lastUsed }))
    .sort((a, b) => b.boost - a.boost || b.lastUsed - a.lastUsed)
    .slice(0, limit)
    .map((entry) => entry.id);
}

const usageEntrySchema = z.object({
  count: z.number().int().positive(),
  lastUsed: z.number().nonnegative(),
});

/** Tolerant load: bad entries are dropped one by one; a non-object document becomes an empty record. */
export function parseUsage(value: unknown): UsageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY_USAGE;
  const entries: [string, UsageEntry][] = [];
  for (const [id, raw] of Object.entries(value)) {
    const parsed = usageEntrySchema.safeParse(raw);
    if (parsed.success) entries.push([id, parsed.data]);
  }
  return Object.fromEntries(entries);
}
