import { describe, expect, test } from 'bun:test';
import { clusterParts, type Candidate } from './dedupe.ts';
import { normalizeLicense } from './license.ts';

function part(
  key: string,
  priority: number,
  hash: string,
  dims: [number, number, number],
  volume: number,
  area = volume,
  mirrors: [string, string, string] = ['', '', ''],
): Candidate {
  return {
    key,
    priority,
    part: {
      geometryHash: hash,
      mirrorHashes: mirrors,
      sortedDimsMm: dims,
      volumeMm3: volume,
      areaMm2: area,
    },
  };
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

  test('parts with equal bounding boxes but different volume or surface area stay separate', () => {
    const plain = part('plain', 1, 'a', [16, 35, 65], 8000);
    const reinforced = part('reinforced', 2, 'b', [16, 35, 65], 8800);
    expect(clusterParts([plain, reinforced])).toHaveLength(2);
    // M3 vs M4 insert: same box, volumes 1.0% apart
    const m3 = part('m3', 1, 'c', [10, 22.5, 26], 2963.7, 2171.2);
    const m4 = part('m4', 2, 'd', [10, 22.5, 26], 2872.8, 2191.9);
    expect(clusterParts([m3, m4])).toHaveLength(2);
    // hook-bottom vs hook-side: volumes 0.4% apart but area 2.4%
    const hookA = part('bottom', 1, 'e', [13.59, 27.55, 32.79], 2569.2, 1515.4);
    const hookB = part('side', 2, 'f', [13.59, 27.55, 32.79], 2559.1, 1552.7);
    expect(clusterParts([hookA, hookB])).toHaveLength(2);
  });
});

describe('mirror images', () => {
  test('left and right hand parts stay separate elements', () => {
    const left = part('arm-left', 1, 'L', [24, 92, 108], 7000, 5000, ['R', '', '']);
    const right = part('arm-right', 2, 'R', [24, 92, 108], 7000, 5000, ['L', '', '']);
    expect(clusterParts([left, right])).toHaveLength(2);
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
    ['CC Attribution-NonCommercial', 'CC-BY-NC-4.0', false],
    ['CC Attribution-NonCommercial-ShareAlike', 'CC-BY-NC-SA-4.0', false],
    ['CC Attribution-NoDerivatives', 'LicenseRef-Unknown', false],
    ['CC BY-SA 4.0', 'LicenseRef-Unknown', false],
  ])('%s -> %s (redistributable %s)', (observed, spdx, redistributable) => {
    const license = normalizeLicense({ ...base, observed });
    expect<string>(license.spdx).toBe(spdx);
    expect(license.redistributable).toBe(redistributable);
  });

  test('NC never wins over BY: "BY-NC" is not read as plain BY', () => {
    expect(normalizeLicense({ ...base, observed: 'BY-NC' }).redistributable).toBe(false);
  });
});
