/** Single-owner lock file: one automation driver per dedicated browser profile. */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DrawError } from '@hsw-editor/draw';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface OwnerLock {
  release(): Promise<void>;
}

/** Lock content is `<pid>:<nonce>`; only the holder that wrote the nonce may remove the file. */
/** Locks held by this process: a same-pid lock file is only a stale leftover when it is not in here. */
const heldHere = new Set<string>();

export async function acquireOwnerLock(file: string, what: string): Promise<OwnerLock> {
  // Reserve synchronously (before any await) so concurrent in-process callers can never both pass.
  if (heldHere.has(file)) {
    throw new DrawError('backend_unavailable', `${what} is already in use by this process`, {
      retryable: true,
    });
  }
  heldHere.add(file);
  try {
    await takeLockFile(file, what);
  } catch (error) {
    heldHere.delete(file);
    throw error;
  }
  return {
    release: async () => {
      await removeIfContent(file, content.get(file) ?? '');
      content.delete(file);
      heldHere.delete(file); // only after the file is gone: no window where it exists unreserved
    },
  };
}

/** What each held lock file contains, so release removes only our own file. */
const content = new Map<string, string>();

async function takeLockFile(file: string, what: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const mine = `${process.pid}:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, mine, { flag: 'wx', mode: 0o600 });
      content.set(file, mine);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const seen = await readFile(file, 'utf8').catch(() => '');
      const owner = Number.parseInt(seen, 10);
      if (Number.isInteger(owner) && owner !== process.pid && alive(owner)) {
        throw new DrawError('backend_unavailable', `${what} is already driven by pid ${owner}`, {
          retryable: true,
        });
      }
      // Stale (dead owner, or our own leftover from a crashed run: this call holds the in-process
      // reservation, so no live holder here can own it). Remove only if still the file we judged stale.
      await removeIfContent(file, seen);
    }
  }
  throw new DrawError('backend_unavailable', `could not take the ${what} owner lock`, {
    retryable: true,
  });
}

async function removeIfContent(file: string, expected: string): Promise<void> {
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === expected) await rm(file, { force: true });
}
