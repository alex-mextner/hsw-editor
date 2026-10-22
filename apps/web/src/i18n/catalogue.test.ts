import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { en } from './en.ts';
import { placeholdersOf } from './format.ts';
import { ru } from './ru.ts';

const enEntries = Object.entries(en);
const ruEntries = new Map(Object.entries(ru));

describe('message catalogues', () => {
  test('every English key has a Russian translation and no stray Russian keys exist', () => {
    const missing = enEntries.map(([key]) => key).filter((key) => !ruEntries.has(key));
    expect(missing).toEqual([]);
    const allowedExtra = /\.(zero|two|few|many)$/;
    const stray = [...ruEntries.keys()].filter((key) => !(key in en) && !allowedExtra.test(key));
    expect(stray).toEqual([]);
  });

  test('translations keep the same {placeholders} and are never empty', () => {
    const problems: string[] = [];
    for (const [key, english] of enEntries) {
      const russian = ruEntries.get(key) ?? '';
      if (russian.trim() === '' || english.trim() === '') problems.push(`${key}: empty`);
      const a = placeholdersOf(english).join(',');
      const b = placeholdersOf(russian).join(',');
      if (a !== b) problems.push(`${key}: {${a}} vs {${b}}`);
    }
    expect(problems).toEqual([]);
  });

  test('every plural group has the forms its language needs', () => {
    const bases = enEntries.map(([key]) => key).filter((key) => key.endsWith('.other'));
    const missing: string[] = [];
    for (const other of bases) {
      const base = other.slice(0, -'.other'.length);
      if (!(`${base}.one` in en)) missing.push(`en ${base}.one`);
      for (const form of ['one', 'few', 'many', 'other']) {
        if (!ruEntries.has(`${base}.${form}`)) missing.push(`ru ${base}.${form}`);
      }
      if (!(ruEntries.get(`${base}.other`) ?? '').includes('{count}'))
        missing.push(`ru ${base}.other lacks {count}`);
    }
    expect(missing).toEqual([]);
  });

  test('source code only uses message keys that exist (static t("...") calls)', async () => {
    const used = new Map<string, string>();
    const pattern = /\b(?:t|tn)\(\s*'([a-zA-Z][\w.-]*)'/g;
    for await (const path of new Glob('**/*.{ts,tsx}').scan({
      cwd: `${import.meta.dir}/..`,
      absolute: true,
    })) {
      if (path.endsWith('.test.ts') || path.includes('/components/ui/')) continue;
      const text = await Bun.file(path).text();
      for (const match of text.matchAll(pattern)) {
        const key = match[1];
        if (key) used.set(key, path);
      }
    }
    const unknown = [...used].filter(([key]) => !(key in en) && !(`${key}.other` in en));
    expect(unknown.map(([key, path]) => `${key} (${path})`)).toEqual([]);
  });
});
