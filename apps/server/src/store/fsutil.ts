/** Durable file primitives for the wall store: atomic replace and fsynced append. */
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

let tmpCounter = 0;

async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export interface AtomicWriteOptions {
  /** Test seam: runs between the temp-file write and the rename, to simulate a crash there. */
  beforeRename?: () => Promise<void> | void;
  /** Permissions of the new file (default: umask-derived). */
  mode?: number;
}

/**
 * Replaces `path` atomically: write a sibling temp file, fsync it, rename over the target, fsync the
 * directory. A crash at any point leaves either the old or the new content, never a mix.
 */
export async function atomicWrite(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const { beforeRename, mode } = options;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  tmpCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter}`;
  const handle = await open(tmp, 'w', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await beforeRename?.();
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await syncDir(dir);
}

/** Appends and fsyncs. The caller guarantees `data` ends with a newline so a torn write is detectable. */
export async function appendDurable(path: string, data: string): Promise<void> {
  const handle = await open(path, 'a');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** A rename onto a directory that already has content. */
export function isExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'EEXIST' || error.code === 'ENOTEMPTY')
  );
}

export async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    (error: unknown) => {
      if (isNotFound(error)) return false;
      throw error;
    },
  );
}
