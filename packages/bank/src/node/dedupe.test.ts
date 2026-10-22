import { describe, expect, test } from 'bun:test';
import { clusterParts, type Candidate } from './dedupe.ts';
import { normalizeLicense } from './license.ts';

function part(
  key: string,
  priority: number,
  hash: string,
  dims: [number, number, number],
  volume: number,
): Candidate {
  return { key, priority, part: { geometryHash: hash, sortedDimsMm: dims, volumeMm3: volume } };
}

describe('clusterParts', () => {
  test('exact hashes merge and the lowest priority value represents the cluster', () => {
    const clusters = clusterParts([
      part('b.stl', 5, 'h1', [10, 20, 30], 1000),
      part('a.stl', 1, 'h1', [99, 99, 99], 1),
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.representative.key).toBe('a.stl');
    expect(clusters[0]?.duplicates.map((d) => d.key)).toEqual(['b.stl']);
  });

  test('a STEP tessellation of an STL part merges by dims and volume, a different part does not', () => {
    const stl = part('insert.stl', 1, 'h-stl', [10, 22.5, 26], 1880);
    const step = part('insert.step', 9, 'h-step', [10, 22.5, 25.98], 1872);
    const other = part('insert-m3.stl', 2, 'h-m3', [10, 22.5, 26], 1650);
    const clusters = clusterParts([step, other, stl]);
    expect(clusters.map((c) => c.representative.key).sort()).toEqual([
      'insert-m3.stl',
      'insert.stl',
    ]);
    expect(clusters.find((c) => c.representative.key === 'insert.stl')?.duplicates[0]?.key).toBe(
      'insert.step',
    );
  });

  test('parts with equal bounding boxes but clearly different volume stay separate', () => {
    const a = part('plain', 1, 'a', [16, 35, 65], 8000);
    const b = part('reinforced', 2, 'b', [16, 35, 65], 8800);
    expect(clusterParts([a, b])).toHaveLength(2);
  });
});

describe('normalizeLicense', () => {
  const base = { attribution: 'x' };
  test.each([
    ['CC-BY-NC', 'CC-BY-NC-4.0', false],
    ['CC-BY-NC-SA', 'CC-BY-NC-SA-4.0', false],
    ['CC BY-NC-SA 4.0', 'CC-BY-NC-SA-4.0', false],
    ['CC-BY', 'CC-BY-4.0', true],
    ['BY', 'CC-BY-4.0', true],
    ['CC Attribution', 'CC-BY-4.0', true],
    ['Standard Digital File License', 'LicenseRef-Standard-Digital-File', false],
    ['', 'LicenseRef-Unknown', false],
    ['project-original', 'MIT', true],
  ])('%s -> %s (redistributable %s)', (observed, spdx, redistributable) => {
    const license = normalizeLicense({ ...base, observed });
    expect<string>(license.spdx).toBe(spdx);
    expect(license.redistributable).toBe(redistributable);
  });

  test('NC never wins over BY: "BY-NC" is not read as plain BY', () => {
    expect(normalizeLicense({ ...base, observed: 'BY-NC' }).redistributable).toBe(false);
  });
});
