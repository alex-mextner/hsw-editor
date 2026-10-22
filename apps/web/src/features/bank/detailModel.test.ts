import { describe, expect, test } from 'bun:test';
import { categoryPathNames, formatRange, safeExternalUrl } from './detailModel.ts';

describe('safeExternalUrl', () => {
  test('allows http and https links', () => {
    expect(safeExternalUrl('https://www.printables.com/model/1')).toBe(
      'https://www.printables.com/model/1',
    );
    expect(safeExternalUrl('http://example.org/a')).toBe('http://example.org/a');
  });

  test('rejects script and data schemes, garbage and missing values', () => {
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(safeExternalUrl('not a url')).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
  });
});

describe('categoryPathNames', () => {
  const name = (en: string) => ({ ru: `ru ${en}`, en });
  const categories = [
    { id: 'holders', name: name('Holders'), order: 10 },
    { id: 'holders/pliers', parent: 'holders', name: name('Pliers'), order: 12 },
  ];

  test('lists the chain root first in the requested language', () => {
    expect(categoryPathNames(categories, 'holders/pliers', 'en')).toEqual(['Holders', 'Pliers']);
    expect(categoryPathNames(categories, 'holders/pliers', 'ru')).toEqual([
      'ru Holders',
      'ru Pliers',
    ]);
  });

  test('falls back to the raw id for an unknown category', () => {
    expect(categoryPathNames(categories, 'gone/x', 'en')).toEqual(['gone', 'gone/x']);
  });
});

describe('formatRange', () => {
  test('joins the bounds with an en dash and trims noise decimals', () => {
    expect(formatRange({ min: 3, max: 12.5 }, 'en')).toBe('3–12.5');
    expect(formatRange({ min: 0.1 + 0.2, max: 8 }, 'en')).toBe('0.3–8');
  });
});
