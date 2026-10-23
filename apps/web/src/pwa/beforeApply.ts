/** What the update flow needs from the offline mirror: a way to wait until accepted writes have landed. */
export interface Flushable {
  flush(): Promise<void>;
}

/**
 * `beforeApply` hook for `startPwa`: the mirror is resolved lazily (the offline runtime pulls in the API layer,
 * which must not become a start-up dependency of the PWA shell) and flushed before the new worker takes over.
 */
export function flushMirrorBeforeApply(loadMirror: () => Promise<Flushable>): () => Promise<void> {
  return async () => {
    const mirror = await loadMirror();
    await mirror.flush();
  };
}
