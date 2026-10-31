/** Static audit: an icon-sized `<Button>` outside the shared `IconButton` (a menu trigger) must carry an aria-label and a title, so no icon is nameless or without a tooltip. */
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..');

/** The opening tags of `<Button ...>` in `source`, braces of attribute expressions respected. */
function buttonTags(source: string): string[] {
  const tags: string[] = [];
  for (const start of source.matchAll(/<Button\b/g)) {
    let depth = 0;
    let index = start.index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) break;
    }
    tags.push(source.slice(start.index, index + 1));
  }
  return tags;
}

describe('icon-sized buttons', () => {
  test('every one outside IconButton has an aria-label and a title', async () => {
    const offenders: string[] = [];
    let seen = 0;
    for await (const file of new Glob('**/*.tsx').scan(SRC)) {
      if (file.includes('components/ui/') || file.includes('vendor/') || file.endsWith('.test.tsx'))
        continue;
      const source = await Bun.file(join(SRC, file)).text();
      for (const tag of buttonTags(source)) {
        if (!/size="icon/.test(tag)) continue;
        seen += 1;
        if (!tag.includes('aria-label') || !tag.includes('title='))
          offenders.push(`${file}: ${tag.slice(0, 60)}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
