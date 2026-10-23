import { afterEach, describe, expect, test } from 'bun:test';
import { OFFLINE_COPY_HEADER } from '../pwa/cachePolicy.ts';
import { fetchJson, reachability } from './http.ts';

const realFetch = globalThis.fetch;
const realReachability = { ...reachability };
afterEach(() => {
  globalThis.fetch = realFetch;
  reachability.onReachable = realReachability.onReachable;
  reachability.onUnreachable = realReachability.onUnreachable;
});

function scripted(response: Response): string[] {
  const events: string[] = [];
  globalThis.fetch = (() => Promise.resolve(response)) as unknown as typeof fetch;
  reachability.onReachable = () => events.push('reachable');
  reachability.onUnreachable = () => events.push('unreachable');
  return events;
}

describe('fetchJson reachability', () => {
  test('an answer from the daemon says it is reachable', async () => {
    const events = scripted(Response.json({ ok: true }));
    expect(await fetchJson('/api/tools')).toEqual({ ok: true });
    expect(events).toEqual(['reachable']);
  });

  test('an answer the worker made from its kept copy says nothing about the daemon', async () => {
    const events = scripted(
      Response.json({ ok: true }, { headers: { [OFFLINE_COPY_HEADER]: '1' } }),
    );
    expect(await fetchJson('/api/tools')).toEqual({ ok: true });
    expect(events).toEqual([]);
  });
});
