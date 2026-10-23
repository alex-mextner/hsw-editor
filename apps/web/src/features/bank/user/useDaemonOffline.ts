import { useSyncExternalStore } from 'react';
import { useStore } from '@/state/react.ts';
import { sessionStore } from '@/wall/session.ts';

function subscribeOnline(notify: () => void): () => void {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

/**
 * Whether the daemon is known to be unreachable: the open wall's sync lost it, or the browser has no network.
 * (A stopped loopback daemon keeps `navigator.onLine` true, so the wall session is the primary signal; calls
 * that fail with a `NetworkError` are handled where they happen.)
 */
export function useDaemonOffline(): boolean {
  const wallOffline = useStore(sessionStore)?.status === 'offline';
  const browserOnline = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  return wallOffline || !browserOnline;
}
