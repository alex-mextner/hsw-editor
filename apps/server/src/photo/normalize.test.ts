import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { sniffImage } from '../image.ts';
import { isAvif, isHeif, normalizePhoto } from './normalize.ts';

const workDir = mkdtempSync(join(tmpdir(), 'hsw-norm-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

/** ftyp box with the `heic` brand: enough for the sniffer, not decodable. */
const HEIC_HEADER = new Uint8Array([
  0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31,
  0x68, 0x65, 0x69, 0x63,
]);

/** A 40x20 JPEG whose raw pixels are wide, tagged with an EXIF orientation. */
async function jpeg(orientation: number | undefined): Promise<Uint8Array> {
  const base = sharp({ create: { width: 40, height: 20, channels: 3, background: '#c33' } }).jpeg();
  const out = orientation === undefined ? base : base.withMetadata({ orientation });
  return new Uint8Array(await out.toBuffer());
}

describe('normalizePhoto', () => {
  test('an upright JPEG is stored untouched', async () => {
    const bytes = await jpeg(undefined);
    const result = await normalizePhoto(bytes, { workDir });
    expect(result.converted).toBe(false);
    expect(result.bytes).toBe(bytes);
  });

  test('EXIF orientation 6 is baked in: dimensions swap and the tag is gone', async () => {
    const result = await normalizePhoto(await jpeg(6), { workDir });
    expect(result).toMatchObject({ converted: true, reason: 'exif-orientation' });
    expect(sniffImage(result.bytes)).toMatchObject({ mime: 'image/jpeg', width: 20, height: 40 });
    expect((await sharp(result.bytes).metadata()).orientation).toBeUndefined();
  });

  test('orientation 3 keeps the size', async () => {
    const result = await normalizePhoto(await jpeg(3), { workDir });
    expect(sniffImage(result.bytes)).toMatchObject({ width: 40, height: 20 });
  });

  test('PNG passes through', async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 3, height: 2, channels: 3, background: '#fff' } })
        .png()
        .toBuffer(),
    );
    expect((await normalizePhoto(png, { workDir })).converted).toBe(false);
  });

  test('HEIC without uv is refused with a clear code', async () => {
    expect(isHeif(HEIC_HEADER)).toBe(true);
    expect(isAvif(HEIC_HEADER)).toBe(false);
    await expect(normalizePhoto(HEIC_HEADER, { workDir, uvPath: null })).rejects.toMatchObject({
      code: 'heic_converter_unavailable',
    });
  });

  test('a broken HEIC reports a conversion failure, not a crash', async () => {
    // /bin/false stands in for a converter that exits non-zero: no network, no uv needed.
    await expect(
      normalizePhoto(HEIC_HEADER, { workDir, uvPath: '/bin/false' }),
    ).rejects.toMatchObject({
      code: 'heic_conversion_failed',
    });
  });

  test('a converter that cannot even start is reported as unavailable, not a 500', async () => {
    await expect(
      normalizePhoto(HEIC_HEADER, { workDir, uvPath: join(workDir, 'no-such-uv') }),
    ).rejects.toMatchObject({ code: 'heic_converter_unavailable' });
  });

  test('an AVIF that also lists the generic mif1 brand is not sent to the HEIC converter', () => {
    const avif = new Uint8Array([
      0, 0, 0, 28, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0, 0x6d, 0x69, 0x66,
      0x31, 0x61, 0x76, 0x69, 0x66,
    ]);
    expect(isAvif(avif)).toBe(true);
    expect(isHeif(avif)).toBe(false);
  });

  test('a forged huge ftyp size is not scanned past the header', () => {
    const forged = new Uint8Array(2_000_000);
    forged.set([0xff, 0xff, 0xff, 0xff, 0x66, 0x74, 0x79, 0x70, 0x78, 0x78, 0x78, 0x78]);
    const started = performance.now();
    expect(isAvif(forged)).toBe(false);
    expect(isHeif(forged)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test('garbage is undecodable', async () => {
    await expect(normalizePhoto(new Uint8Array([1, 2, 3, 4]), { workDir })).rejects.toMatchObject({
      code: 'photo_undecodable',
    });
  });
});
