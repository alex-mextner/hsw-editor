import { useEffect, useRef, useState } from 'react';
import type { Board } from '@hsw-editor/core';
import { InvalidZoneClient } from './client.ts';
import type { EngineItem, SolveResult } from './engine.ts';
import type { SolidSource } from './protocol.ts';
import { spawnInvalidZoneWorker } from './spawnWorker.ts';

/** `?bench` probe (like FpsProbe): worker round trips since the page loaded, read by the perf proof. */
function recordSolveTime(ms: number): void {
  const root = globalThis.document.documentElement.dataset;
  const times: number[] = JSON.parse(root['zoneSolveMs'] ?? '[]');
  times.push(+ms.toFixed(1));
  root['zoneSolveMs'] = JSON.stringify(times.slice(-2000));
}

/**
 * Exact invalid zones of the scene, computed in a worker. `items` and `sources` must be referentially stable
 * between renders when nothing changed (memoise them); while a drag is live pass the dragged poses so the stripes
 * follow the pointer. Returns `null` while disabled or before the first result.
 */
export function useInvalidZones(
  enabled: boolean,
  board: Board,
  items: readonly EngineItem[],
  sources: ReadonlyMap<string, SolidSource>,
): SolveResult | null {
  const [result, setResult] = useState<SolveResult | null>(null);
  const client = useRef<InvalidZoneClient | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const bench = new URLSearchParams(globalThis.location?.search).has('bench');
    const created = new InvalidZoneClient(
      spawnInvalidZoneWorker,
      (next, roundTripMs) => {
        setResult(next);
        if (bench && roundTripMs !== undefined) recordSolveTime(roundTripMs);
      },
      (message) => console.warn(`[invalid-zones] ${message}`),
    );
    client.current = created;
    return () => {
      created.dispose();
      client.current = null;
      setResult(null);
    };
  }, [enabled]);

  useEffect(() => {
    if (enabled) client.current?.update(board, items, sources);
  }, [enabled, board, items, sources]);

  return enabled ? result : null;
}
