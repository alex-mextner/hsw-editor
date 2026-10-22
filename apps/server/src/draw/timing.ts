import { DrawError } from '@hsw-editor/draw';

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const jitter = (minMs: number, maxMs: number) => minMs + Math.random() * (maxMs - minMs);

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DrawError('timeout', 'aborted', { retryable: false }));
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DrawError('timeout', 'aborted', { retryable: false }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
