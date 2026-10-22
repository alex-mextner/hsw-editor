import { expect, test } from 'bun:test';
import sharp from 'sharp';
import { sniffImage } from './image.ts';

async function encoded(
  format: 'png' | 'jpeg' | 'webp',
  width: number,
  height: number,
  alpha: boolean,
) {
  const base = sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 200, g: 40, b: 40, alpha: alpha ? 0.5 : 1 },
    },
  });
  const out =
    format === 'png'
      ? base.png()
      : format === 'jpeg'
        ? base.jpeg()
        : base.webp(alpha ? { lossless: false } : {});
  return new Uint8Array(await out.toBuffer());
}

test.each([
  ['png', 1024, 768, false],
  ['jpeg', 1024, 768, false],
  ['webp', 1024, 768, false],
  ['webp', 1024, 768, true], // alpha forces the extended VP8X container
  ['webp', 300, 5000, true],
] as const)(
  'sniffImage reads the real size of %s %ix%i (alpha=%s)',
  async (format, w, h, alpha) => {
    const info = sniffImage(await encoded(format, w, h, alpha));
    expect(info).toMatchObject({ width: w, height: h, mime: `image/${format}` });
  },
);

test('sniffImage rejects non-images', () => {
  expect(
    sniffImage(new TextEncoder().encode('<html>not an image at all, but long enough</html>')),
  ).toBeNull();
});
