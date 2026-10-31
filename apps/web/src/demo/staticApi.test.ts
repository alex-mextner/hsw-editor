import { afterEach, describe, expect, test } from 'bun:test';
import { installFetch, restoreFetch } from '@/test/fetchStub.ts';
import { createDemoFetch, DEMO_UNAVAILABLE, warmClassList } from './staticApi.ts';

const HTML_404 = (): Response =>
  new Response('<!doctype html><title>404</title>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  });

/** A host that ships only what the demo build copies: the class list and one class thumbnail. */
function host(): { calls: string[]; fetch: ReturnType<typeof createDemoFetch> } {
  const calls: string[] = [];
  const real = (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), 'http://localhost/').pathname;
    calls.push(path);
    if (path === '/api/tools/assets/classes') {
      return Promise.resolve(Response.json({ classes: [{ id: 'hammer' }] }));
    }
    if (path === '/api/tools/classes/hammer/thumb.webp') {
      return Promise.resolve(new Response('webp', { headers: { 'content-type': 'image/webp' } }));
    }
    return Promise.resolve(HTML_404());
  };
  return { calls, fetch: createDemoFetch(real) };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body.error.message).not.toMatch(/404/);
  return body.error.code;
}

describe('demo static API', () => {
  test('the user library is empty, not missing', async () => {
    const { fetch, calls } = host();
    expect(await (await fetch('/api/tools')).json()).toEqual({ tools: [] });
    expect(calls).toEqual([]);
  });

  test('the class list is the static file the build ships', async () => {
    const { fetch, calls } = host();
    expect(await (await fetch('/api/tools/classes')).json()).toEqual({
      classes: [{ id: 'hammer' }],
    });
    expect(calls).toEqual(['/api/tools/assets/classes']);
  });

  test('thumbnails and other shipped files pass through untouched', async () => {
    const { fetch } = host();
    const response = await fetch('/api/tools/classes/hammer/thumb.webp?preset=claw');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('webp');
  });

  test('a route the build does not ship answers a friendly error, not the host 404', async () => {
    const { fetch } = host();
    for (const path of ['/api/tools/vision', '/api/tools/drafts/x', '/api/tools/hammer-1']) {
      const response = await fetch(path);
      expect(response.status).toBe(501);
      expect(await errorCode(response)).toBe(DEMO_UNAVAILABLE);
    }
  });

  test('writes need a daemon', async () => {
    const { fetch, calls } = host();
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const response = await fetch('/api/tools/drafts', { method });
      expect(await errorCode(response)).toBe(DEMO_UNAVAILABLE);
    }
    expect(calls).toEqual([]);
  });

  test('a class holding and model are generated in the browser for any parameter values', async () => {
    const { fetch } = host();
    const params = encodeURIComponent(JSON.stringify({ length: 300 }));
    const holding = await fetch(`/api/tools/classes/hammer/holding?p=${params}`);
    expect(holding.status).toBe(200);
    expect(
      ((await holding.json()) as { holding: { lengthMm: number } }).holding.lengthMm,
    ).toBeGreaterThan(0);
    const glb = await fetch('/api/tools/classes/hammer/model.glb?lod=0');
    expect(new Uint8Array(await glb.arrayBuffer()).slice(0, 4)).toEqual(
      new Uint8Array([0x67, 0x6c, 0x54, 0x46]),
    );
  });

  test('an unknown class, preset or malformed parameters are a friendly error', async () => {
    const { fetch } = host();
    for (const path of [
      '/api/tools/classes/nope/holding',
      '/api/tools/classes/hammer/holding?preset=nope',
      '/api/tools/classes/hammer/holding?p=%7B',
    ]) {
      expect(await errorCode(await fetch(path))).toBe(DEMO_UNAVAILABLE);
    }
  });
});

describe('warmClassList', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function stubWorker(worker: object | undefined): void {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: worker === undefined ? {} : { serviceWorker: worker },
    });
  }

  afterEach(() => {
    restoreFetch();
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  test('asks for the class list again, past the HTTP cache, once the worker controls the page', async () => {
    const seen: { url: string; cache: RequestCache | undefined }[] = [];
    installFetch((url, init) => {
      seen.push({ url, cache: init?.cache });
      return Response.json({ classes: [] });
    });
    stubWorker({ ready: Promise.resolve({}), controller: {} });
    await warmClassList();
    expect(seen).toEqual([{ url: '/api/tools/classes', cache: 'reload' }]);
  });

  test('waits for the worker to claim the page when it is ready before it controls it', async () => {
    const seen: string[] = [];
    installFetch((url) => {
      seen.push(url);
      return Response.json({ classes: [] });
    });
    const listeners: (() => void)[] = [];
    stubWorker({
      ready: Promise.resolve({}),
      controller: null,
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    });
    const done = warmClassList();
    await Bun.sleep(5);
    expect(seen).toEqual([]);
    for (const listener of listeners) listener();
    await done;
    expect(seen).toEqual(['/api/tools/classes']);
  });

  test('does nothing without a service worker', async () => {
    let calls = 0;
    installFetch(() => {
      calls += 1;
      return Response.json({});
    });
    stubWorker(undefined);
    await warmClassList();
    expect(calls).toBe(0);
  });
});
