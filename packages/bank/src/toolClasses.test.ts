import { describe, expect, test } from 'bun:test';
import { TOOL_CLASSES } from './toolClasses.ts';

const fold = (word: string): string => word.toLowerCase().replaceAll('ё', 'е');

describe('tool class vocabulary', () => {
  test('ids are unique slugs', () => {
    const ids = TOOL_CLASSES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  // Whole phrases only: a single word may appear inside phrases of several classes ("drill" in "drill bit").
  test('no exact synonym phrase is listed under two classes', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const t of TOOL_CLASSES) {
      for (const word of [...t.synonyms.ru, ...t.synonyms.en]) {
        const key = fold(word);
        const previous = owner.get(key);
        if (previous !== undefined && previous !== t.id) {
          clashes.push(`${key}: ${previous} / ${t.id}`);
        }
        owner.set(key, t.id);
      }
    }
    expect(clashes).toEqual([]);
  });
});
