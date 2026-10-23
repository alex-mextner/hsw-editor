import { describe, expect, test } from 'bun:test';
import { highlightRuns } from './HighlightedText.tsx';

describe('highlightRuns', () => {
  test('groups consecutive matched characters', () => {
    expect(highlightRuns('Toggle theme', [0, 1, 7, 8])).toEqual([
      { text: 'To', match: true },
      { text: 'ggle ', match: false },
      { text: 'th', match: true },
      { text: 'eme', match: false },
    ]);
  });

  test('no positions is one plain run, empty text no runs', () => {
    expect(highlightRuns('Undo', [])).toEqual([{ text: 'Undo', match: false }]);
    expect(highlightRuns('', [])).toEqual([]);
  });

  test('positions past the end are ignored', () => {
    expect(highlightRuns('ab', [1, 9])).toEqual([
      { text: 'a', match: false },
      { text: 'b', match: true },
    ]);
  });
});
