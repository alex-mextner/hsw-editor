/**
 * Free-form tags of a user tool (library filter chips). Stored normalised: trimmed, lower-cased, empty entries
 * dropped, duplicates removed in first-seen order; each 1-40 characters, at most 20 per tool.
 */
import { z } from 'zod';

export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS = 20;

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase();
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** Union of tag lists, normalised (first list's order first). */
export function unionTags(...lists: readonly (readonly string[])[]): string[] {
  return normalizeTags(lists.flat());
}

export const TagsSchema = z
  .array(z.string())
  .transform(normalizeTags)
  .pipe(z.array(z.string().min(1).max(MAX_TAG_LENGTH)).max(MAX_TAGS));
