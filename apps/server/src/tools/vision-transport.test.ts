import { describe, expect, test } from 'bun:test';
import { VisionRequestError, VisionUnavailableError } from '@hsw-editor/tools/node';
import type { VisionClient, VisionStatus } from '../vision/client.ts';
import { VisionError } from '../vision/types.ts';
import { ManagedVisionTransport } from './vision-transport.ts';

function clientWith(overrides: Partial<VisionClient> & { status?: () => Promise<VisionStatus> }) {
  const unused = async (): Promise<never> => {
    throw new Error('not used');
  };
  const client: VisionClient = {
    calibrate: unused,
    segment: unused,
    fit: unused,
    photoToWall: unused,
    photoToObjects: unused,
    post: unused,
    postStream: unused,
    status: unused,
    stop: async () => {},
    ...overrides,
  };
  return client;
}

const STATE = { running: false, managed: false, endpoint: null, health: null, models: null };

describe('ManagedVisionTransport', () => {
  test('a stopped sidecar that can be started counts as available; one that cannot says what to run', async () => {
    const startable = new ManagedVisionTransport(
      clientWith({ status: async () => ({ ...STATE, startable: true }) }),
    );
    expect(await startable.status()).toEqual({ available: true });
    const missing = new ManagedVisionTransport(
      clientWith({ status: async () => ({ ...STATE, startable: false }) }),
    );
    const down = await missing.status();
    expect(down.available).toBe(false);
    expect(down.message).toContain('hsw-editor vision setup');
    const external = new ManagedVisionTransport(
      clientWith({
        status: async () => ({ ...STATE, startable: false, endpoint: 'http://127.0.0.1:9' }),
      }),
    );
    const externalDown = await external.status();
    expect(externalDown.message).toContain('http://127.0.0.1:9');
    const running = new ManagedVisionTransport(
      clientWith({
        status: async () => ({
          ...STATE,
          running: true,
          startable: true,
          endpoint: 'http://127.0.0.1:8795',
        }),
      }),
    );
    expect(await running.status()).toEqual({ available: true, url: 'http://127.0.0.1:8795' });
  });

  test('a client that cannot read its state is unavailable with the reason, not an exception', async () => {
    const broken = new ManagedVisionTransport(
      clientWith({
        status: async () => {
          throw new Error('state.json is corrupt');
        },
      }),
    );
    expect(await broken.status()).toEqual({
      available: false,
      message: 'the vision service state cannot be read: state.json is corrupt',
    });
  });

  test('install/start failures are VisionUnavailableError with the fix, sidecar answers are VisionRequestError', async () => {
    const notInstalled = new ManagedVisionTransport(
      clientWith({
        post: async () => {
          throw new VisionError('vision_not_installed', 'no venv', {
            fix: 'hsw-editor vision setup',
          });
        },
      }),
    );
    const unavailable = await notInstalled.postJson('/objects/merge', {}).catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(VisionUnavailableError);
    expect((unavailable as VisionUnavailableError).fix).toBe('hsw-editor vision setup');

    const refused = new ManagedVisionTransport(
      clientWith({
        postStream: async () => {
          throw new VisionError('models_missing', 'no weights', { fix: 'fetch-models' });
        },
      }),
    );
    const failure = await refused
      .postStream('/photo-to-objects', {}, undefined)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(VisionRequestError);
    expect((failure as VisionRequestError).code).toBe('models_missing');
    expect((failure as VisionRequestError).message).toContain('fetch-models');
  });

  test('a body with undefined optional fields (as the port builds it) is sent without them', async () => {
    const seen: unknown[] = [];
    const transport = new ManagedVisionTransport(
      clientWith({ post: async (_path, body) => (seen.push(body), {}) }),
    );
    await transport.postJson('/objects/add', {
      out_dir: '/x',
      point_px: [1, 2],
      max_objects: undefined,
    });
    expect(seen).toEqual([{ out_dir: '/x', point_px: [1, 2] }]);
  });

  test('bodies are forwarded as JSON and the events reach the callback', async () => {
    const seen: unknown[] = [];
    const transport = new ManagedVisionTransport(
      clientWith({
        post: async (_path, body) => (seen.push(body), { ok: true }),
        postStream: async (_path, _body, onEvent) => {
          onEvent({ event: 'stage' });
          return { status: 'ok' };
        },
      }),
    );
    expect(await transport.postJson('/objects/split', { id: 3, n: 2 })).toEqual({ ok: true });
    expect(seen).toEqual([{ id: 3, n: 2 }]);
    const events: string[] = [];
    await transport.postStream('/photo-to-objects', {}, (e) => events.push(e.event ?? ''));
    expect(events).toEqual(['stage']);
  });
});
