import { useCallback, useSyncExternalStore } from 'react';

/** Wall-clock time in ms, refreshed every `intervalMs` while `active`; frozen (no timer) otherwise. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!active) return () => undefined;
      const timer = setInterval(notify, intervalMs);
      return () => clearInterval(timer);
    },
    [active, intervalMs],
  );
  return useSyncExternalStore(
    subscribe,
    () => Math.floor(Date.now() / intervalMs) * intervalMs,
    () => 0,
  );
}
