import { describe, expect, test } from 'bun:test';
import {
  applyFilters,
  buildCategoryTree,
  candidateElements,
  cardWidth,
  categoryChain,
  countByCategory,
  gridColumns,
  moveIndex,
  NO_FILTERS,
  rowStride,
  sizeBucket,
  type BankFilters,
  type FilterTarget,
} from './filters.ts';

interface TestElement extends FilterTarget {
  readonly id: string;
}

function element(id: string, overrides: Partial<Omit<TestElement, 'id'>> = {}): TestElement {
  return {
    id,
    category: 'holders/pliers',
    toolClasses: [],
    footprint: { cells: [{}] },
    generated: false,
    license: { redistributable: true },
    ...overrides,
  };
}

function cells(count: number): { cells: readonly object[] } {
  return { cells: Array.from({ length: count }, () => ({})) };
}

const filters = (patch: Partial<BankFilters>): BankFilters => ({ ...NO_FILTERS, ...patch });

describe('category filter', () => {
  const pliers = element('pliers', { category: 'holders/pliers' });
  const holdersRoot = element('root', { category: 'holders' });
  const hooks = element('hook', { category: 'hooks/hooks' });
  // "hol" is a string prefix of "holders" but not an ancestor of it.
  const lookalike = element('lookalike', { category: 'holderside/x' });
  const all = [pliers, holdersRoot, hooks, lookalike];

  test('a top-level category includes its whole subtree and itself', () => {
    const ids = applyFilters(all, filters({ category: 'holders' })).map((e) => e.id);
    expect(ids).toEqual(['pliers', 'root']);
  });

  test('a leaf category excludes its parent and siblings', () => {
    const ids = applyFilters(all, filters({ category: 'holders/pliers' })).map((e) => e.id);
    expect(ids).toEqual(['pliers']);
  });

  test('ignoreCategory counts under the other filters only', () => {
    const narrowed = filters({ category: 'hooks', redistributableOnly: true });
    const closed = element('closed', {
      category: 'hooks/pegs',
      license: { redistributable: false },
    });
    const ids = applyFilters([...all, closed], narrowed, { ignoreCategory: true }).map((e) => e.id);
    expect(ids).toEqual(['pliers', 'root', 'hook', 'lookalike']);
  });
});

describe('combined filters', () => {
  const items = [
    element('a', { toolClasses: ['pliers'], footprint: cells(2), generated: true }),
    element('b', { toolClasses: ['pliers', 'snips'], footprint: cells(4) }),
    element('c', {
      toolClasses: ['snips'],
      footprint: cells(6),
      license: { redistributable: false },
    }),
    element('d', { toolClasses: [], footprint: cells(1), generated: true }),
  ];

  test('every active filter must match', () => {
    const ids = (patch: Partial<BankFilters>) =>
      applyFilters(items, filters(patch)).map((e) => e.id);
    expect(ids({ toolClasses: ['snips'] })).toEqual(['b', 'c']);
    expect(ids({ toolClasses: ['snips'], size: 's3to4' })).toEqual(['b']);
    expect(ids({ redistributableOnly: true, size: 's5plus' })).toEqual([]);
    expect(ids({ origin: 'generated' })).toEqual(['a', 'd']);
    expect(ids({ origin: 'sources', toolClasses: ['pliers'] })).toEqual(['b']);
    expect(ids({ toolClasses: ['pliers', 'snips'] })).toEqual(['a', 'b', 'c']);
    expect(ids({})).toEqual(['a', 'b', 'c', 'd']);
  });

  test('the "mine" origin keeps only the user\'s own elements and "sources" drops them', () => {
    const mine = element('m', { source: 'user' });
    const downloaded = element('s');
    const generated = element('g', { generated: true });
    const all = [mine, downloaded, generated];
    const ids = (patch: Partial<BankFilters>) => applyFilters(all, filters(patch)).map((e) => e.id);
    expect(ids({ origin: 'mine' })).toEqual(['m']);
    expect(ids({ origin: 'sources' })).toEqual(['s']);
    expect(ids({ origin: 'generated' })).toEqual(['g']);
    expect(ids({})).toEqual(['m', 's', 'g']);
  });

  test('size buckets cover 1, 2, 3-4 and 5+ cells', () => {
    expect([1, 2, 3, 4, 5, 12].map(sizeBucket)).toEqual([
      's1',
      's2',
      's3to4',
      's3to4',
      's5plus',
      's5plus',
    ]);
  });
});

describe('category counts and tree', () => {
  test('counts roll up to every ancestor', () => {
    const counts = countByCategory([
      { category: 'holders/pliers' },
      { category: 'holders/pliers' },
      { category: 'holders/drills' },
      { category: 'hooks' },
    ]);
    expect(counts.get('holders')).toBe(3);
    expect(counts.get('holders/pliers')).toBe(2);
    expect(counts.get('hooks')).toBe(1);
    expect(counts.get('bins')).toBeUndefined();
  });

  test('tree orders by `order` and nests children under their parent', () => {
    const name = { ru: 'x', en: 'x' };
    const tree = buildCategoryTree([
      { id: 'hooks', name, order: 30 },
      { id: 'holders/drills', parent: 'holders', name, order: 15 },
      { id: 'holders', name, order: 10 },
      { id: 'holders/pliers', parent: 'holders', name, order: 12 },
      { id: 'orphan/x', parent: 'orphan', name, order: 99 },
    ]);
    expect(tree.map((node) => node.category.id)).toEqual(['holders', 'hooks', 'orphan/x']);
    expect(tree[0]?.children.map((node) => node.category.id)).toEqual([
      'holders/pliers',
      'holders/drills',
    ]);
  });

  test('categoryChain lists ancestors root first', () => {
    expect(categoryChain('holders/pliers')).toEqual(['holders', 'holders/pliers']);
    expect(categoryChain('panels')).toEqual(['panels']);
  });
});

describe('candidateElements', () => {
  const a = element('a');
  const b = element('b');
  const byId = new Map([
    ['a', a],
    ['b', b],
  ]);

  test('null ranking keeps the index order', () => {
    expect(candidateElements([a, b], byId, null)).toEqual([a, b]);
  });

  test('ranking sets the order and drops unknown ids', () => {
    expect(candidateElements([a, b], byId, ['b', 'gone', 'a'])).toEqual([b, a]);
  });
});

describe('grid geometry', () => {
  test('a 320px panel shows two columns and a phone-width 360px screen too', () => {
    expect(gridColumns(320)).toBe(2);
    expect(gridColumns(304)).toBe(2);
    expect(gridColumns(360)).toBe(2);
  });

  test('columns grow with width and never drop below one', () => {
    expect(gridColumns(400)).toBe(3);
    expect(gridColumns(560)).toBe(4);
    expect(gridColumns(100)).toBe(1);
    expect(gridColumns(0)).toBe(1);
  });

  test('cards fill the usable width exactly, gaps included', () => {
    const columns = gridColumns(320);
    const width = cardWidth(320, columns);
    expect(width * columns + 8 * (columns - 1)).toBeCloseTo(320 - 16, 6);
    expect(rowStride(width)).toBe(width + 84 + 8);
  });
});

describe('moveIndex', () => {
  test('left/right step by one and stop at the ends', () => {
    expect(moveIndex(3, 'ArrowRight', 2, 10)).toBe(4);
    expect(moveIndex(9, 'ArrowRight', 2, 10)).toBe(9);
    expect(moveIndex(0, 'ArrowLeft', 2, 10)).toBe(0);
  });

  test('up/down step by a row; a short last row is reachable', () => {
    expect(moveIndex(4, 'ArrowUp', 3, 10)).toBe(1);
    expect(moveIndex(1, 'ArrowUp', 3, 10)).toBe(1);
    expect(moveIndex(4, 'ArrowDown', 3, 10)).toBe(7);
    // Row 2 is [6,7,8], row 3 is just [9]: from column 1 of row 2 go to 9.
    expect(moveIndex(7, 'ArrowDown', 3, 10)).toBe(9);
    expect(moveIndex(9, 'ArrowDown', 3, 10)).toBe(9);
  });

  test('home and end jump to the first and last card', () => {
    expect(moveIndex(5, 'Home', 3, 10)).toBe(0);
    expect(moveIndex(5, 'End', 3, 10)).toBe(9);
    expect(moveIndex(0, 'End', 3, 0)).toBe(0);
  });
});
