import { afterEach, describe, expect, test } from 'bun:test';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import {
  ensureToolAssets,
  entryForBankClass,
  entryForSource,
  refreshToolAssets,
  toolAssetsStore,
} from './assets.ts';
import { classEntry, readyState, userToolEntry } from './testing.ts';

afterEach(() => {
  restoreFetch();
  toolAssetsStore.set({ status: 'idle' });
});

const screwdriver = classEntry('screwdriver', 'screwdriver');
const pliers = classEntry('pliers-combination', 'pliers');
const sideCutters = classEntry('side-cutters', 'snips');
const hexKeySet = classEntry('hex-key-set', 'hex-key-set');

function indexBody(hash: string, entries = [screwdriver, pliers]) {
  return { schemaVersion: 1, contentHash: hash, entries, unavailable: [] };
}

describe('lookup', () => {
  const state = readyState([
    screwdriver,
    pliers,
    sideCutters,
    hexKeySet,
    userToolEntry('mine', screwdriver),
  ]);

  test('a bank class finds the generator of that name, else the first one declaring it, else a broader class', () => {
    expect(entryForBankClass(state, 'screwdriver', [])?.id).toBe('class:screwdriver');
    expect(entryForBankClass(state, 'snips', [])?.id).toBe('class:side-cutters');
    expect(entryForBankClass(state, 'chisel', ['screwdriver'])?.id).toBe('class:screwdriver');
    expect(entryForBankClass(state, 'usb-stick', [])).toBeUndefined();
    expect(entryForBankClass({ status: 'loading' }, 'screwdriver', [])).toBeUndefined();
  });

  test('a class or user tool is found by its id', () => {
    expect(entryForSource(state, { kind: 'class', id: 'hex-key-set' })?.id).toBe(
      'class:hex-key-set',
    );
    expect(entryForSource(state, { kind: 'tool', id: 'mine' })?.kind).toBe('tool');
    expect(entryForSource(state, { kind: 'tool', id: 'other' })).toBeUndefined();
  });
});

describe('refreshToolAssets', () => {
  test('loads the index once for concurrent callers and validates it', async () => {
    let calls = 0;
    installFetch(() => {
      calls += 1;
      return Response.json(indexBody('a'.repeat(16)));
    });
    await Promise.all([refreshToolAssets(), refreshToolAssets()]);
    expect(calls).toBe(1);
    const state = toolAssetsStore.get();
    expect(state.status).toBe('ready');
    if (state.status === 'ready') expect(state.byId.size).toBe(2);
  });

  test('an unchanged hash keeps the very same state object so nothing downstream re-renders', async () => {
    installFetch(() => Response.json(indexBody('b'.repeat(16))));
    await refreshToolAssets();
    const first = toolAssetsStore.get();
    await refreshToolAssets({ force: true });
    expect(toolAssetsStore.get()).toBe(first);
    installFetch(() => Response.json(indexBody('c'.repeat(16), [screwdriver])));
    await refreshToolAssets({ force: true });
    expect(toolAssetsStore.get()).not.toBe(first);
  });

  test('a failed first load is an error that is retried later; a failed refetch keeps the index we have', async () => {
    installFetch(() => new Response('nope', { status: 503 }));
    await refreshToolAssets();
    expect(toolAssetsStore.get()).toMatchObject({ status: 'error', message: 'HTTP 503' });
    installFetch(() => Response.json(indexBody('d'.repeat(16))));
    toolAssetsStore.set({ status: 'error', message: 'old', at: Date.now() - 60_000 });
    ensureToolAssets();
    ensureToolAssets();
    expect(toolAssetsStore.get().status).toBe('error');
    await Promise.resolve();
    await refreshToolAssets();
    expect(toolAssetsStore.get().status).toBe('ready');
    const ready = toolAssetsStore.get();
    installFetch(() => new Response('down', { status: 502 }));
    await refreshToolAssets({ force: true });
    expect(toolAssetsStore.get()).toBe(ready);
  });

  test('a body that is not an index is an error, not a half-loaded store', async () => {
    installFetch(() => Response.json({ entries: 'nope' }));
    await refreshToolAssets();
    expect(toolAssetsStore.get().status).toBe('error');
  });
});
