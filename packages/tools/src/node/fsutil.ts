import { randomBytes } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';

/** Atomic file write: temp file next to the target, then rename. */
export async function writeAtomic(path: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Runs async work one at a time per key (the daemon is the single writer, so an in-process queue is enough). */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
