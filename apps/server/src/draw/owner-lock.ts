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
export async function acquireOwnerLock(file: string, what: string): Promise<OwnerLock> {
  await mkdir(dirname(file), { recursive: true });
  const content = `${process.pid}:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(file, content, { flag: 'wx', mode: 0o600 });
      return { release: () => removeIfContent(file, content) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const seen = await readFile(file, 'utf8').catch(() => '');
      const owner = Number.parseInt(seen, 10);
      if (Number.isInteger(owner) && owner !== process.pid && alive(owner)) {
        throw new DrawError('backend_unavailable', `${what} is already driven by pid ${owner}`, {
          retryable: true,
        });
      }
      // Stale (dead owner or our own leftover): remove it only if it is still the file we judged
      // stale, so a lock another process just took is never deleted.
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
