import { afterEach, describe, expect, test } from 'bun:test';
import { installFetch, restoreFetch, settleRequests } from '@/test/fetchStub.ts';
import {
  clearRequests,
  handleRequestEvent,
  loadOpenRequests,
  requestsStore,
} from './requests.ts';

function request(id: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'compare',
    status: 'open',
    createdBy: { kind: 'agent', name: 'omp' },
    createdAt,
    payload: { modelRefIds: ['m1', 'm2'] },
    ...extra,
  };
}

/** A list endpoint the test answers by hand, so events can land while the load is in flight. */
function manualList() {
  const pending: ((response: Response) => void)[] = [];
  installFetch(
    () =>
      new Promise<Response>((resolve) => {
        pending.push(resolve);
      }),
  );
  return {
    async answer(requests: unknown[]) {
      await settleRequests();
      const resolve = pending.shift();
      if (!resolve) throw new Error('no list request in flight');
      resolve(Response.json({ requests }));
    },
    async fail() {
      await settleRequests();
      const resolve = pending.shift();
      if (!resolve) throw new Error('no list request in flight');
      resolve(new Response('boom', { status: 500 }));
    },
  };
}

function ids(): string[] {
  return requestsStore.get().requests.map((entry) => entry.id);
}

afterEach(() => {
  clearRequests();
  restoreFetch();
});

describe('loadOpenRequests', () => {
  test('an event that arrived during the load wins over the fetched copy of the same id', async () => {
    const list = manualList();
    const loading = loadOpenRequests('w1');
    handleRequestEvent('request_input', {
      request: request('r1', '2026-10-22T10:00:00.000Z', { payload: { modelRefIds: ['new'] } }),
    });
    await list.answer([request('r1', '2026-10-22T10:00:00.000Z')]);
    await loading;
    const [only] = requestsStore.get().requests;
    expect(ids()).toEqual(['r1']);
    expect(only?.kind === 'compare' && only.payload.modelRefIds).toEqual(['new']);
    expect(requestsStore.get().status).toBe('ready');
  });

  test('a request resolved during the load is not resurrected by the older list', async () => {
    const list = manualList();
    const loading = loadOpenRequests('w1');
    handleRequestEvent('request_resolved', { id: 'r1', status: 'answered' });
    await list.answer([request('r1', '2026-10-22T10:00:00.000Z'), request('r2', '2026-10-22T11:00:00.000Z')]);
    await loading;
    expect(ids()).toEqual(['r2']);
  });

  test('a failed reload of the same wall clears the stale cards instead of keeping them', async () => {
    const list = manualList();
    const first = loadOpenRequests('w1');
    await list.answer([request('r1', '2026-10-22T10:00:00.000Z')]);
    await first;
    expect(ids()).toEqual(['r1']);

    const reload = loadOpenRequests('w1');
    expect(ids()).toEqual(['r1']); // kept on screen while loading
    await list.fail();
    await reload;
    expect(requestsStore.get().status).toBe('error');
    expect(ids()).toEqual([]);
  });

  test('a response that lands after clearRequests() is discarded', async () => {
    const list = manualList();
    const loading = loadOpenRequests('w1');
    clearRequests();
    await list.answer([request('r1', '2026-10-22T10:00:00.000Z')]);
    await loading;
    await settleRequests();
    expect(requestsStore.get().wallId).toBeNull();
    expect(ids()).toEqual([]);
  });
});
