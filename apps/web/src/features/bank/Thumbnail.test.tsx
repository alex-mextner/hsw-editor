import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { localeStore } from '@/i18n/index.ts';
import { mount, withDomGlobals, type Mounted } from '@/test/dom.tsx';
import { bankElement } from '@/test/fixtures.ts';
import { glyphModel, GLYPH_SIZE, hashString } from './glyph.ts';
import { Thumbnail } from './Thumbnail.tsx';

let mounted: Mounted | null = null;
beforeEach(() => localeStore.set('en'));
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

withDomGlobals();

describe('Thumbnail fallback', () => {
  test('an element with no thumbnail path shows the generated footprint instead of a broken image', async () => {
    const base = bankElement('no-thumb');
    const element = {
      ...base,
      assets: { ...base.assets, thumbnail: { ...base.assets.thumbnail, path: '' } },
    };
    mounted = await mount(<Thumbnail element={element} />);
    expect(mounted.container.querySelector('img')).toBeNull();
    expect(mounted.container.querySelectorAll('svg polygon')).toHaveLength(
      element.footprint.cells.length,
    );
    expect(mounted.container.querySelector('[title]')?.getAttribute('title')).toContain('Outline');
  });

  test('a thumbnail request that fails swaps the image for the generated outline', async () => {
    const element = bankElement('broken-thumb');
    mounted = await mount(<Thumbnail element={element} />);
    const image = mounted.container.querySelector('img');
    expect(image?.getAttribute('src')).toBe(`/bank/assets/${element.assets.thumbnail.path}`);
    expect(mounted.container.querySelector('svg')).toBeNull();

    await act(async () => {
      image?.dispatchEvent(new Event('error'));
    });
    expect(mounted.container.querySelector('img')).toBeNull();
    expect(mounted.container.querySelectorAll('svg polygon')).toHaveLength(3);
  });

  test('a thumbnail that loads is left alone', async () => {
    mounted = await mount(<Thumbnail element={bankElement('fine')} />);
    await act(async () => {
      mounted?.container.querySelector('img')?.dispatchEvent(new Event('load'));
    });
    expect(mounted.container.querySelector('img')?.className).toContain('opacity-100');
    expect(mounted.container.querySelector('svg')).toBeNull();
  });
});

describe('glyphModel', () => {
  const element = bankElement('glyph-sample');

  test('is deterministic and derives the tint from the id', () => {
    expect(glyphModel(element)).toEqual(glyphModel(element));
    expect(glyphModel(element).hue).toBe(hashString('glyph-sample') % 360);
    expect(glyphModel(bankElement('another-element')).hue).not.toBe(glyphModel(element).hue);
  });

  test('draws one hexagon (six corners) per footprint cell', () => {
    const glyph = glyphModel(element);
    expect(glyph.hexes).toHaveLength(element.footprint.cells.length);
    for (const points of glyph.hexes) expect(points.split(' ')).toHaveLength(6);
  });

  test('keeps the bounding-box proportions of the element', () => {
    const wide = glyphModel(bankElement('w', { dimsMm: { x: 120, y: 30, z: 10 } }));
    const tall = glyphModel(bankElement('t', { dimsMm: { x: 30, y: 120, z: 10 } }));
    expect(wide.bbox.width / wide.bbox.height).toBeCloseTo(4, 1);
    expect(tall.bbox.height / tall.bbox.width).toBeCloseTo(4, 1);
  });

  test('everything fits the canvas, even for degenerate dimensions', () => {
    const glyph = glyphModel(bankElement('flat', { dimsMm: { x: 0, y: 0, z: 0 } }));
    const numbers = glyph.hexes.flatMap((points) => points.split(/[ ,]/).map(Number));
    for (const value of [...numbers, glyph.bbox.x, glyph.bbox.y]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(GLYPH_SIZE);
    }
  });
});
