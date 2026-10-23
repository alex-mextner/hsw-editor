/** Every registered class (default build and every preset) renders a real thumbnail and a holding interface. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, listToolClasses, presetValues } from '@hsw-editor/tools';
import '@hsw-editor/tools/node';
import { encodePng } from '@hsw-editor/tools/render';
import { classThumb } from './thumbs.ts';

const home = mkdtempSync(join(tmpdir(), 'hsw-thumbs-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Size of a fully transparent thumbnail of the same dimensions: a rendered tool compresses to far more. */
async function blankSize(): Promise<number> {
  const png = encodePng(new Uint8Array(256 * 256 * 4), 256, 256);
  return (await new Bun.Image(png).webp({ quality: 85 }).bytes()).byteLength;
}

describe('class thumbnails', () => {
  const classes = listToolClasses();

  test('there are classes to render', () => {
    expect(classes.length).toBeGreaterThan(10);
  });

  test('every class: default thumb is a non-blank webp within the time budget', async () => {
    const started = performance.now();
    const blank = await blankSize();
    const seen = new Set<string>();
    for (const cls of classes) {
      const bytes = await classThumb(home, generate(cls.id, {}, 0), true).bytes;
      expect(bytes.byteLength, cls.id).toBeGreaterThan(200);
      expect(
        String.fromCharCode(...bytes.slice(0, 4)) + String.fromCharCode(...bytes.slice(8, 12)),
      ).toBe('RIFFWEBP');
      expect(bytes.byteLength, cls.id).toBeGreaterThan(blank * 2);
      seen.add(Buffer.from(bytes).toString('base64'));
    }
    expect(seen.size).toBeGreaterThan(classes.length * 0.9);
    expect(performance.now() - started).toBeLessThan(120_000);
  }, 180_000);

  test('every preset of every class renders and has a holding interface', async () => {
    for (const cls of classes) {
      for (const preset of cls.presets) {
        const model = generate(cls.id, presetValues(cls.id, preset.id), 0);
        expect(model.holding.lengthMm, `${cls.id}/${preset.id}`).toBeGreaterThan(0);
        const bytes = await classThumb(home, model, true).bytes;
        expect(bytes.byteLength, `${cls.id}/${preset.id}`).toBeGreaterThan(200);
      }
    }
  }, 300_000);
});
