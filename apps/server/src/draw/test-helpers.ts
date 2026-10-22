/** Shared fixtures for draw tests: scratch dirs under ~/.cache/hsw-editor, tiny real PNGs. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

export interface Scratch {
  readonly dir: string;
  cleanup(): Promise<void>;
}

export async function scratchDir(): Promise<Scratch> {
  const base = join(homedir(), '.cache/hsw-editor/test-tmp');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'draw-'));
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }),
  };
}

/** White canvas with a centred blue box: passes the quality gate for a square request. */
export async function writeObjectPng(path: string, size = 512): Promise<void> {
  const box = Math.round(size * 0.4);
  const overlay = await sharp({
    create: { width: box, height: box, channels: 3, background: { r: 30, g: 60, b: 160 } },
  })
    .png()
    .toBuffer();
  await sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } })
    .composite([
      { input: overlay, left: Math.round((size - box) / 2), top: Math.round((size - box) / 2) },
    ])
    .png()
    .toFile(path);
}

export async function pngBytes(size = 512): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: size, height: size, channels: 3, background: '#ffffff' } })
      .png()
      .toBuffer(),
  );
}
