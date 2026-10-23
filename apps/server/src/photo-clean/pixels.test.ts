import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rasterisePolygon } from '@hsw-editor/overlay';
import { outsideDrift } from './composite.ts';
import { canvasPng, maskPixels, placeOnCanvas, readPixels, uncanvas } from './pixels.ts';

describe('placeOnCanvas', () => {
  test('picks the allowed canvas closest in shape and fits the photo inside, centred', () => {
    expect(placeOnCanvas(1152, 1536)).toMatchObject({
      size: '1024x1536',
      x: 0,
      y: 85,
      width: 1024,
      height: 1365,
    });
    expect(placeOnCanvas(1600, 1000)).toMatchObject({ size: '1536x1024', canvasWidth: 1536 });
    expect(placeOnCanvas(1000, 1000)).toMatchObject({ size: '1024x1024', x: 0, y: 0 });
  });
});

/** A photo with a bright left half and a dark right half, so a misplaced or scrambled canvas shows. */
function halves(width: number, height: number) {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = x < width / 2 ? 220 : 40;
      data[(y * width + x) * 3] = v;
      data[(y * width + x) * 3 + 1] = v;
      data[(y * width + x) * 3 + 2] = v;
    }
  }
  return { width, height, data };
}

describe('canvas round trip', () => {
  test('the photo comes back from its canvas as it went in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixels-'));
    try {
      const photo = halves(300, 400);
      const placement = placeOnCanvas(photo.width, photo.height);
      const path = join(dir, 'canvas.png');
      await Bun.write(path, await canvasPng(photo, placement));
      const back = await uncanvas(path, placement, photo.width, photo.height);
      const mask = new Uint8Array(photo.width * photo.height);
      expect(outsideDrift(photo.data, back.data, photo.width, photo.height, mask)).toBeLessThan(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the mask canvas is white exactly over the area, black elsewhere and in the padding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pixels-'));
    try {
      const width = 300;
      const height = 400;
      const area = rasterisePolygon(
        [
          [60, 100],
          [240, 100],
          [240, 300],
          [60, 300],
        ],
        width,
        height,
      );
      const placement = placeOnCanvas(width, height);
      const path = join(dir, 'mask.png');
      await Bun.write(
        path,
        await canvasPng(maskPixels(area, width, height), placement, { r: 0, g: 0, b: 0 }),
      );
      const canvas = await readPixels(path);
      expect(canvas.width).toBe(placement.canvasWidth);
      const at = (x: number, y: number): number => canvas.data[(y * canvas.width + x) * 3] ?? -1;
      // The photo's (150, 200) lands at the canvas' scaled position.
      const scale = placement.width / width;
      const inside = at(
        Math.round(placement.x + 150 * scale),
        Math.round(placement.y + 200 * scale),
      );
      const outside = at(
        Math.round(placement.x + 20 * scale),
        Math.round(placement.y + 50 * scale),
      );
      expect(inside).toBeGreaterThan(240);
      expect(outside).toBeLessThan(15);
      // The padding above the photo (when the canvas is taller than the scaled photo) is black, never a stripe.
      if (placement.y > 4) expect(at(10, 2)).toBeLessThan(15);
      // No striping: every row of one band reads the same.
      const row = (y: number): number[] =>
        Array.from({ length: 12 }, (_, i) => at(Math.round(placement.x + (100 + i) * scale), y));
      const y0 = Math.round(placement.y + 200 * scale);
      expect(row(y0)).toEqual(row(y0 + 1));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
