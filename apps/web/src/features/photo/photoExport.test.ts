import { describe, expect, test } from 'bun:test';
import { bannerBox, exportFileName, exportSize, MAX_EXPORT_SIDE } from './photoExport.ts';

describe('exportSize', () => {
  test('keeps a small photo as it is and scales a large one to the cap, aspect kept', () => {
    expect(exportSize({ width: 1152, height: 1536 })).toEqual({ width: 1152, height: 1536 });
    const big = exportSize({ width: 4032, height: 3024 });
    expect(big.width).toBe(MAX_EXPORT_SIDE);
    expect(big.height).toBe(1536);
  });
});

describe('exportFileName', () => {
  test('is a safe lower-case slug, with a fallback for names with no letters', () => {
    expect(exportFileName('Kitchen wall #2')).toBe('kitchen-wall-2-overlay.png');
    expect(exportFileName('Гараж: стена')).toBe('гараж-стена-overlay.png');
    expect(exportFileName('***')).toBe('wall-overlay.png');
  });
});

describe('bannerBox', () => {
  test('is inset from the edges and scales with the picture width', () => {
    const small = bannerBox({ width: 400, height: 300 });
    const large = bannerBox({ width: 2000, height: 1500 });
    expect(small.x).toBeGreaterThan(0);
    expect(small.x * 2 + small.width).toBeCloseTo(400, 8);
    expect(large.height / small.height).toBeCloseTo(5, 8);
    expect(small.subtitlePx).toBeLessThan(small.titlePx);
  });
});
