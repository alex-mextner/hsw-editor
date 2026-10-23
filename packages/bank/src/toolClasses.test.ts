import { describe, expect, test } from 'bun:test';
import {
  acceptedToolClasses,
  broaderToolClasses,
  expandToolClasses,
  finerToolClasses,
  toolClassVocabulary,
  TOOL_CLASSES,
} from './toolClasses.ts';

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

describe('broader classes', () => {
  test('the finer classes name the coarser one they refine', () => {
    const broader = Object.fromEntries(
      TOOL_CLASSES.filter((t) => t.broader !== undefined).map((t) => [t.id, t.broader]),
    );
    expect(broader).toEqual({
      chisel: 'knife',
      punch: 'screwdriver',
      hacksaw: 'saw',
      level: 'ruler',
      square: 'ruler',
      'long-nose-pliers': 'pliers',
      'locking-pliers': 'pliers',
      'water-pump-pliers': 'pliers',
      crimper: 'pliers',
      'hex-key-set': 'hex-key',
    });
  });

  test('broaderToolClasses reads the given vocabulary and falls back to the built-in one', () => {
    expect(broaderToolClasses('chisel')).toEqual(['knife']);
    expect(broaderToolClasses('knife')).toEqual([]);
    expect(broaderToolClasses('no-such-class')).toEqual([]);
    expect(broaderToolClasses('chisel', [{ id: 'chisel', broader: 'screwdriver' }])).toEqual([
      'screwdriver',
    ]);
    // A seed index that predates the class: the built-in vocabulary still answers.
    expect(broaderToolClasses('chisel', [{ id: 'knife' }])).toEqual(['knife']);
  });

  test('acceptedToolClasses lists the class first, then the coarser one', () => {
    expect(acceptedToolClasses('chisel')).toEqual(['chisel', 'knife']);
    expect(acceptedToolClasses('knife')).toEqual(['knife']);
  });

  test('expandToolClasses deduplicates and keeps first-seen order', () => {
    expect(expandToolClasses(['chisel', 'knife', 'saw'])).toEqual(['chisel', 'knife', 'saw']);
    expect(expandToolClasses([])).toEqual([]);
  });

  test('finerToolClasses groups the finer classes by the coarse one, also those a declared vocabulary lacks', () => {
    expect(
      finerToolClasses(TOOL_CLASSES)
        .get('saw')
        ?.map((t) => t.id),
    ).toEqual(['hacksaw']);
    expect(
      finerToolClasses(TOOL_CLASSES)
        .get('pliers')
        ?.map((t) => t.id),
    ).toEqual(['long-nose-pliers', 'locking-pliers', 'water-pump-pliers', 'crimper']);
    const declared = TOOL_CLASSES.filter((t) => t.id === 'knife');
    expect(
      finerToolClasses(declared)
        .get('knife')
        ?.map((t) => t.id),
    ).toEqual(['chisel']);
    expect(finerToolClasses(TOOL_CLASSES).get('nothing')).toBeUndefined();
  });

  test('toolClassVocabulary keeps the declared classes and adds the built-in ones it lacks', () => {
    expect(toolClassVocabulary([])).toBe(TOOL_CLASSES);
    const declared = TOOL_CLASSES.filter((t) => t.id !== 'chisel');
    const merged = toolClassVocabulary(declared);
    expect(merged.slice(0, declared.length)).toEqual(declared);
    expect(merged.map((t) => t.id)).toContain('chisel');
    const custom = { id: 'custom', name: { ru: 'К', en: 'C' }, synonyms: { ru: [], en: [] } };
    expect(toolClassVocabulary([custom])[0]).toBe(custom);
  });
});
