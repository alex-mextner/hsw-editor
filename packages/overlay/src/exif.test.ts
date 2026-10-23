import { describe, expect, test } from 'bun:test';
import { fitLongSide, orientationTransform, orientedSize, readJpegExif } from './exif.ts';

/** A minimal JPEG: SOI, APP1(Exif) with the given TIFF entries, SOF-less tail. */
function jpegWithExif(opts: {
  little: boolean;
  orientation?: number;
  focal35mm?: number;
}): Uint8Array {
  const { little } = opts;
  const u16 = (v: number): number[] => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number): number[] =>
    little
      ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24]
      : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const entry = (tag: number, type: number, value: number): number[] => [
    ...u16(tag),
    ...u16(type),
    ...u32(1),
    ...(type === 3 ? [...u16(value), 0, 0] : u32(value)),
  ];
  const ifd0: number[] = [];
  const entries0: number[][] = [];
  if (opts.orientation !== undefined) entries0.push(entry(0x0112, 3, opts.orientation));
  const exifIfdOffset = 8 + 2 + (entries0.length + (opts.focal35mm === undefined ? 0 : 1)) * 12 + 4;
  if (opts.focal35mm !== undefined) entries0.push(entry(0x8769, 4, exifIfdOffset));
  ifd0.push(...u16(entries0.length), ...entries0.flat(), ...u32(0));
  const exifIfd: number[] =
    opts.focal35mm === undefined ? [] : [...u16(1), ...entry(0xa405, 3, opts.focal35mm), ...u32(0)];
  const tiff = [
    ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
    ...u16(42),
    ...u32(8),
    ...ifd0,
    ...exifIfd,
  ];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = body.length + 2;
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 255, ...body, 0xff, 0xd9]);
}

describe('readJpegExif', () => {
  test.each([true, false])(
    'reads orientation and 35 mm focal length (little-endian: %p)',
    (little) => {
      expect(readJpegExif(jpegWithExif({ little, orientation: 6, focal35mm: 26 }))).toEqual({
        orientation: 6,
        focal35mm: 26,
      });
      expect(readJpegExif(jpegWithExif({ little, orientation: 3 }))).toEqual({ orientation: 3 });
    },
  );

  test('defaults for missing, out-of-range, truncated and non-JPEG input, never throwing', () => {
    expect(readJpegExif(jpegWithExif({ little: true }))).toEqual({ orientation: 1 });
    expect(readJpegExif(jpegWithExif({ little: true, orientation: 9 }))).toEqual({
      orientation: 1,
    });
    const whole = jpegWithExif({ little: false, orientation: 8 });
    for (let cut = 0; cut < whole.length; cut += 3) {
      expect(readJpegExif(whole.subarray(0, cut)).orientation).toBeGreaterThanOrEqual(1);
    }
    expect(readJpegExif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toEqual({
      orientation: 1,
    });
    expect(readJpegExif(new Uint8Array())).toEqual({ orientation: 1 });
  });
});

describe('orientation geometry', () => {
  test('orientations 5-8 swap the axes', () => {
    expect(orientedSize(4000, 3000, 1)).toEqual({ width: 4000, height: 3000 });
    expect(orientedSize(4000, 3000, 6)).toEqual({ width: 3000, height: 4000 });
  });

  test('transforms map the raw image corners into the oriented rectangle', () => {
    const w = 40;
    const h = 30;
    for (let orientation = 1; orientation <= 8; orientation++) {
      const [a, b, c, d, e, f] = orientationTransform(orientation, w, h);
      const out = orientedSize(w, h, orientation);
      for (const [x, y] of [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ] as const) {
        const px = a * x + c * y + e;
        const py = b * x + d * y + f;
        expect(px).toBeGreaterThanOrEqual(-1e-9);
        expect(px).toBeLessThanOrEqual(out.width + 1e-9);
        expect(py).toBeGreaterThanOrEqual(-1e-9);
        expect(py).toBeLessThanOrEqual(out.height + 1e-9);
      }
    }
  });

  test('orientation 6 (camera turned right) puts the raw top-left corner at the oriented top-right', () => {
    const [a, b, c, d, e, f] = orientationTransform(6, 40, 30);
    expect([a * 0 + c * 0 + e, b * 0 + d * 0 + f]).toEqual([30, 0]);
  });

  test('fitLongSide downscales and never upscales', () => {
    expect(fitLongSide(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(fitLongSide(1000, 800, 2000)).toEqual({ width: 1000, height: 800 });
  });
});
