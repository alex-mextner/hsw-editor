/**
 * The browser composition root of the offline layer: the IndexedDB wall mirror and the one connection monitor the whole
 * app shares. Where IndexedDB is unavailable (private mode, old browsers) the mirror is in memory, so the editor works the
 * same but forgets the queue on reload.
 */
import { reachability } from '@/api/http.ts';
import { ConnectionMonitor } from './connection.ts';
import { idbStore, offlineDbProvider } from './idb.ts';
import { createMemoryStore } from './kv.ts';
import { WallMirror } from './mirror.ts';
import { parseWallRecord, type WallRecord } from './record.ts';

export const wallMirror = new WallMirror(
  typeof indexedDB === 'undefined'
    ? createMemoryStore<WallRecord>(parseWallRecord)
    : idbStore(offlineDbProvider(), 'walls', parseWallRecord),
);

/** `GET /api/health` answers while the daemon is up, with a short timeout so a hung daemon counts as down. */
async function probeDaemon(): Promise<boolean> {
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const connection = new ConnectionMonitor({
  probe: probeDaemon,
  browserOnline: () => navigator.onLine,
});

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => connection.notifyBrowserOnline());
  window.addEventListener('offline', () => connection.notifyBrowserOffline());
}

reachability.onReachable = () => connection.reportSuccess();
reachability.onUnreachable = () => connection.reportFailure();
