/** Image header sniffing, saving and pixel decoding for generated/uploaded views. */
import { createHash } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DrawError, type DrawImage, type DrawMime, type RawImage } from '@hsw-editor/draw';
import sharp from 'sharp';

interface Sniffed {
  readonly mime: DrawMime;
  readonly width: number;
  readonly height: number;
}

export function sniffImage(bytes: Uint8Array): Sniffed | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number) => bytes[i] ?? 0;
  if (bytes.length > 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length > 4 && at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return null;
      const marker = at(i + 1);
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { mime: 'image/jpeg', height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      }
      i += 2 + view.getUint16(i + 2);
    }
    return null;
  }
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length > 30 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const kind = tag(12);
    if (kind === 'VP8X') {
      return {
        mime: 'image/webp',
        width: 1 + (view.getUint32(24, true) & 0xffffff),
        height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)),
      };
    }
    if (kind === 'VP8L') {
      const bits = view.getUint32(21, true);
      return {
        mime: 'image/webp',
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    if (kind === 'VP8 ') {
      return {
        mime: 'image/webp',
        width: view.getUint16(26, true) & 0x3fff,
        height: view.getUint16(28, true) & 0x3fff,
      };
    }
  }
  return null;
}

const EXTENSION: Record<DrawMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp)$/i;

/** Validate bytes are a real image and write them atomically to outDir/<stem>.<ext>. */
export async function saveImage(
  outDir: string,
  stem: string,
  bytes: Uint8Array,
): Promise<DrawImage> {
  const info = sniffImage(bytes);
  if (!info) {
    throw new DrawError('refused', 'payload is not a png/jpeg/webp image', { retryable: false });
  }
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${stem}.${EXTENSION[info.mime]}`);
  const partial = `${path}.part`;
  await Bun.write(partial, bytes);
  await rename(partial, path);
  return {
    path,
    mime: info.mime,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: info.width,
    height: info.height,
  };
}

export async function decodeRaw(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function safeStem(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '').replace(/[^\w.-]+/g, '_').slice(0, 80);
  return cleaned === '' ? fallback : cleaned;
}
