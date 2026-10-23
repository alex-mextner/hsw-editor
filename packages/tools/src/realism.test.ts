import { describe, expect, test } from 'bun:test';
import './classes/index.ts';
import { REALISM, realismProblems } from './realism.ts';
import { generate, listToolClasses, presetValues } from './registry.ts';

describe('realism table', () => {
  test('every class has an entry and every entry names a class', () => {
    const ids = listToolClasses().map((cls) => cls.id);
    expect(Object.keys(REALISM).sort()).toEqual([...ids].sort());
  });

  for (const cls of listToolClasses()) {
    test(`${cls.id}: the default and every preset measure what a real tool does`, () => {
      const variants: [string, Record<string, string | number>][] = [
        ['default', {}],
        ...cls.presets.map((preset): [string, Record<string, string | number>] => [
          preset.id,
          presetValues(cls.id, preset.id),
        ]),
      ];
      for (const [name, values] of variants) {
        const model = generate(cls.id, values, 1);
        const problems = realismProblems(cls.id, model.bounds, model.holding);
        expect({ variant: `${cls.id}/${name}`, problems }).toEqual({
          variant: `${cls.id}/${name}`,
          problems: [],
        });
      }
    });
  }

  test('the checks catch what they are for: a screwdriver with a stub of a blade on a normal handle', () => {
    const stub = generate('screwdriver', { shaftLength: 30 }, 1);
    const names = realismProblems('screwdriver', stub.bounds, stub.holding).map((p) => p.what);
    expect(names).toContain('shaftLength');
    expect(names).toContain('shaftLength/handleLength');
    const fine = generate('screwdriver', {}, 1);
    expect(realismProblems('screwdriver', fine.bounds, fine.holding)).toEqual([]);
  });
});
