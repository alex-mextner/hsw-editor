/**
 * Photo intake normaliser. Every pixel coordinate of the wall overlay refers to the ORIENTED image, so a phone photo
 * (pixels as the sensor read them + an EXIF "rotate me") is rotated once here and stored without the tag. Browsers
 * cannot decode HEIC, so iPhone photos are converted to JPEG too.
 *
 *  - JPEG with EXIF orientation 2..8: rotated by sharp (no external tool, works offline).
 *  - AVIF: converted by sharp.
 *  - HEIC/HEIF: converted by `scripts/normalize_photo.py` through `uv run --script` (pillow-heif). The two wheels are
 *    fetched by uv on first use and cached; without uv or offline-before-first-use the upload is refused with a clear
 *    message instead of storing a photo the browser cannot show.
 *  - PNG and WebP carrying an EXIF orientation are rotated the same way (re-encoded to JPEG, or PNG when they have alpha).
 *  - Everything else the router already accepts (upright JPEG, PNG, WebP) is stored untouched.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import sharp from 'sharp';
import { sniffImage } from '../image.ts';

export type NormalizeErrorCode =
  | 'photo_undecodable'
  | 'heic_converter_unavailable'
  | 'heic_conversion_failed';

export class NormalizeError extends Error {
  readonly code: NormalizeErrorCode;
  constructor(code: NormalizeErrorCode, message: string) {
    super(message);
    this.name = 'NormalizeError';
    this.code = code;
  }
}

export interface NormalizedPhoto {
  readonly bytes: Uint8Array;
  /** True when the stored bytes differ from the upload (rotated and/or converted). */
  readonly converted: boolean;
  /** Why it was converted, for logs and the UI. */
  readonly reason?: 'exif-orientation' | 'heif' | 'avif';
}

export interface NormalizeOptions {
  /** Scratch directory for the converter (created on demand). */
  readonly workDir: string;
  /** Overrides for tests. */
  readonly uvPath?: string | null;
  readonly scriptPath?: string;
  readonly timeoutMs?: number;
}

const SCRIPT_PATH = join(import.meta.dir, '../../scripts/normalize_photo.py');
const JPEG_QUALITY = 92;
const CONVERTER_TIMEOUT_MS = 90_000;
const MAX_FTYP_BYTES = 256;
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);

function brandOf(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  return tag(4) === 'ftyp' ? tag(8) : null;
}

/** Major brand plus the compatible brands of the leading ftyp box. */
function allBrands(bytes: Uint8Array): string[] {
  const major = brandOf(bytes);
  if (major === null) return [];
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  // A real ftyp box is tens of bytes; the size field is untrusted, so never scan more than 256 bytes.
  const end = Math.min(size >= 16 ? size : 16, bytes.length, MAX_FTYP_BYTES);
  const brands = [major];
  for (let at = 16; at + 4 <= end; at += 4) {
    brands.push(String.fromCharCode(...bytes.subarray(at, at + 4)));
  }
  return brands;
}

export function isAvif(bytes: Uint8Array): boolean {
  return allBrands(bytes).some((brand) => brand === 'avif' || brand === 'avis');
}

export function isHeif(bytes: Uint8Array): boolean {
  // An AVIF often carries the generic `mif1` brand too: it is decoded by sharp, not by the HEIC converter.
  return !isAvif(bytes) && allBrands(bytes).some((brand) => HEIF_BRANDS.has(brand));
}

async function rotateWithSharp(bytes: Uint8Array): Promise<Uint8Array> {
  // `rotate()` without arguments applies the EXIF orientation; sharp drops the metadata (and the tag) on output.
  // failOn 'none': a truncated phone JPEG that browsers still show must not become an upload error.
  const image = sharp(bytes, { failOn: 'none' }).rotate();
  const { hasAlpha } = await sharp(bytes, { failOn: 'none' }).metadata();
  const out = hasAlpha === true ? image.png() : image.jpeg({ quality: JPEG_QUALITY });
  return new Uint8Array(await out.toBuffer());
}

/** `uv` on PATH, else the default install location (a systemd user unit's PATH omits ~/.local/bin). */
function findUv(): string | null {
  const onPath = Bun.which('uv');
  if (onPath !== null) return onPath;
  const fallback = join(homedir(), '.local/bin/uv');
  return existsSync(fallback) ? fallback : null;
}

async function convertHeif(bytes: Uint8Array, options: NormalizeOptions): Promise<Uint8Array> {
  const uv = options.uvPath === undefined ? findUv() : options.uvPath;
  if (uv === null) {
    throw new NormalizeError(
      'heic_converter_unavailable',
      'HEIC photos need `uv` (https://docs.astral.sh/uv/) to convert them; install it, or export the photo as JPEG',
    );
  }
  await mkdir(options.workDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const input = join(options.workDir, `heic-${stamp}.in`);
  const output = join(options.workDir, `heic-${stamp}.jpg`);
  try {
    await writeFile(input, bytes);
    let child: Subprocess<'ignore', 'pipe', 'pipe'>;
    try {
      child = Bun.spawn([uv, 'run', '--script', options.scriptPath ?? SCRIPT_PATH, input, output], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: options.timeoutMs ?? CONVERTER_TIMEOUT_MS,
      });
    } catch (error) {
      throw new NormalizeError(
        'heic_converter_unavailable',
        `cannot start uv (${uv}): ${String(error)}`,
      );
    }
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) {
      const detail = stderr.trim().split('\n').at(-1) || `exit code ${exitCode}`;
      throw new NormalizeError(
        'heic_conversion_failed',
        `HEIC conversion failed (${detail}); the converter fetches pillow-heif once, so it needs network the first time`,
      );
    }
    return new Uint8Array(await readFile(output));
  } finally {
    await Promise.all([rm(input, { force: true }), rm(output, { force: true })]);
  }
}

/** Returns bytes the browser can display with every pixel upright. Throws `NormalizeError`. */
export async function normalizePhoto(
  bytes: Uint8Array,
  options: NormalizeOptions,
): Promise<NormalizedPhoto> {
  const info = sniffImage(bytes);
  if (info !== null) {
    let orientation: number | undefined;
    try {
      orientation = (await sharp(bytes, { failOn: 'none' }).metadata()).orientation;
    } catch (error) {
      throw new NormalizeError('photo_undecodable', `cannot read the image: ${String(error)}`);
    }
    if (orientation === undefined || orientation === 1) return { bytes, converted: false };
    try {
      return { bytes: await rotateWithSharp(bytes), converted: true, reason: 'exif-orientation' };
    } catch (error) {
      throw new NormalizeError('photo_undecodable', `cannot rotate the image: ${String(error)}`);
    }
  }
  if (isAvif(bytes)) {
    try {
      return { bytes: await rotateWithSharp(bytes), converted: true, reason: 'avif' };
    } catch (error) {
      throw new NormalizeError('photo_undecodable', `cannot decode the AVIF: ${String(error)}`);
    }
  }
  if (isHeif(bytes)) {
    return { bytes: await convertHeif(bytes, options), converted: true, reason: 'heif' };
  }
  throw new NormalizeError('photo_undecodable', 'not a JPEG, PNG, WebP, AVIF or HEIC image');
}
