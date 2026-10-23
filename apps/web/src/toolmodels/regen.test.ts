import { describe, expect, test } from 'bun:test';
import { boundsDims, generate } from '@hsw-editor/tools';
import { ModelRegen, type RegenRequest } from './regen.ts';
import { regenerate } from './regenCore.ts';
import { FakeRegenPort, FakeUrls } from './testing.ts';

function screwdriverRequest(key: string, length: number): RegenRequest {
  return { key, classId: 'screwdriver', base: {}, target: { y: length } };
}

const baseLength = boundsDims(generate('screwdriver', {}, 1).bounds).y;

function regen(autoRun = false, maxKept?: number) {
  const port = new FakeRegenPort(autoRun);
  const urls = new FakeUrls();
  let settled = 0;
  const models = new ModelRegen(
    () => port,
    urls,
    () => {
      settled += 1;
    },
    maxKept,
  );
  return { port, urls, models, settled: () => settled };
}

describe('regenerate', () => {
  test('builds both LODs at the wanted length with the hash of its values', () => {
    const result = regenerate(screwdriverRequest('k', baseLength + 30));
    expect(result.reached).toBe(true);
    expect(result.dimsMm.y).toBeCloseTo(baseLength + 30, 0);
    expect(result.lod1.byteLength).toBeLessThan(result.lod0.byteLength);
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.holding.lengthMm).toBeGreaterThan(baseLength);
    expect(new DataView(result.lod0.buffer).getUint32(0, true)).toBe(0x46546c67);
  });
});

describe('ModelRegen', () => {
  test('a request is pending until the worker answers, then ready with blob urls', () => {
    const { port, models, urls, settled } = regen();
    expect(models.request(screwdriverRequest('a', baseLength + 20)).status).toBe('pending');
    expect(models.request(screwdriverRequest('a', baseLength + 20)).status).toBe('pending');
    expect(port.posted).toHaveLength(1);
    port.flush();
    const built = models.get('a');
    expect(built?.status).toBe('ready');
    if (built?.status !== 'ready') throw new Error('not ready');
    expect(urls.live.has(built.lod0)).toBe(true);
    expect(built.dimsMm.y).toBeCloseTo(baseLength + 20, 0);
    expect(settled()).toBe(1);
  });

  test('while one build runs only the newest wanted size of a class waits behind it', () => {
    const { port, models } = regen();
    models.request(screwdriverRequest('first', baseLength + 10));
    models.request(screwdriverRequest('second', baseLength + 20));
    models.request(screwdriverRequest('third', baseLength + 30));
    expect(models.get('second')).toBeUndefined();
    expect(port.posted.map((m) => m.key)).toEqual(['first']);
    port.flush();
    expect(port.posted.map((m) => m.key)).toEqual(['third']);
    port.flush();
    expect(models.get('first')?.status).toBe('ready');
    expect(models.get('third')?.status).toBe('ready');
  });

  test('a build that throws is a failure that is remembered, and the next request still runs', () => {
    const { port, models } = regen(true);
    port.failWith = 'generator exploded';
    models.request(screwdriverRequest('bad', baseLength + 10));
    expect(models.get('bad')).toEqual({ status: 'failed', message: 'generator exploded' });
    expect(models.request(screwdriverRequest('bad', baseLength + 10)).status).toBe('failed');
    port.failWith = null;
    models.request(screwdriverRequest('good', baseLength + 12));
    expect(models.get('good')?.status).toBe('ready');
  });

  test('a crashed worker fails what it had, is replaced and serves the next request', () => {
    let spawned = 0;
    const ports: FakeRegenPort[] = [];
    const models = new ModelRegen(
      () => {
        spawned += 1;
        const next = new FakeRegenPort();
        ports.push(next);
        return next;
      },
      new FakeUrls(),
      () => undefined,
    );
    models.request(screwdriverRequest('a', baseLength + 10));
    ports[0]?.onerror?.({ message: 'out of memory' } as ErrorEvent);
    expect(models.get('a')).toEqual({ status: 'failed', message: 'out of memory' });
    expect(ports[0]?.terminated).toBe(true);
    models.request(screwdriverRequest('b', baseLength + 14));
    expect(spawned).toBe(2);
    ports[1]?.flush();
    expect(models.get('b')?.status).toBe('ready');
  });

  test('a crash fails only the build that was running; what waited is built by the new worker', () => {
    const ports: FakeRegenPort[] = [];
    const models = new ModelRegen(
      () => {
        const next = new FakeRegenPort();
        ports.push(next);
        return next;
      },
      new FakeUrls(),
      () => undefined,
    );
    models.request({
      key: 'running',
      classId: 'screwdriver',
      base: {},
      target: { y: baseLength + 10 },
    });
    models.request({ key: 'waits', classId: 'hammer', base: {}, target: { y: 300 } });
    ports[0]?.onerror?.({ message: 'out of memory' } as ErrorEvent);
    expect(models.get('running')?.status).toBe('failed');
    expect(models.get('waits')?.status).toBe('pending');
    expect(ports).toHaveLength(2);
    ports[1]?.flush();
    expect(models.get('waits')?.status).toBe('ready');
  });

  test('old builds are dropped past the keep limit and their urls are revoked', () => {
    const { models, urls } = regen(true, 6);
    for (let i = 0; i < 10; i++)
      models.request(screwdriverRequest(`k${i}`, baseLength + 1 + (i % 40)));
    expect(models.get('k0')).toBeUndefined();
    expect(models.get('k9')?.status).toBe('ready');
    expect(urls.live.size).toBeLessThanOrEqual(6 * 2);
    models.dispose();
    expect(urls.live.size).toBe(0);
  });
});
