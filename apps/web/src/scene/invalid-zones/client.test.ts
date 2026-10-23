import { describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD, PoseSchema } from '@hsw-editor/core';
import { InvalidZoneClient, type WorkerPort } from './client.ts';
import type { EngineItem, SolveResult } from './engine.ts';
import type { FromWorker, SolidSource, ToWorker } from './protocol.ts';

class FakeWorker implements WorkerPort {
  sent: ToWorker[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  failNextPost = false;
  postMessage(message: ToWorker): void {
    if (this.failNextPost && message.type === 'solve') {
      this.failNextPost = false;
      throw new Error('DataCloneError');
    }
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: FromWorker): void {
    this.onmessage?.(new MessageEvent('message', { data: message }));
  }
  solves(): Extract<ToWorker, { type: 'solve' }>[] {
    return this.sent.filter((m): m is Extract<ToWorker, { type: 'solve' }> => m.type === 'solve');
  }
}

const empty: SolveResult = {
  reasons: [],
  regions: [],
  pending: [],
  stats: { pairsTested: 0, cacheHits: 0, booleans: 0 },
};
const item = (id: string, x: number): EngineItem => ({
  id,
  kind: 'holder',
  solidKey: 'cube',
  pose: PoseSchema.parse({ x }),
});
const sources = new Map<string, SolidSource>([
  ['cube', { kind: 'box', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }],
]);

function setup() {
  const worker = new FakeWorker();
  const results: SolveResult[] = [];
  const client = new InvalidZoneClient(
    () => worker,
    (result) => results.push(result),
  );
  return { worker, results, client };
}

describe('InvalidZoneClient', () => {
  test('defines each solid once and sends the first scene immediately', () => {
    const { worker, client } = setup();
    client.update(DEFAULT_BOARD, [item('a', 1), item('b', 2)], sources);
    expect(worker.sent.filter((m) => m.type === 'define')).toHaveLength(1);
    expect(worker.solves()).toHaveLength(1);
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    expect(worker.sent.filter((m) => m.type === 'define')).toHaveLength(1);
  });

  test('keeps one solve in flight and solves only the newest queued scene afterwards', () => {
    const { worker, results, client } = setup();
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    client.update(DEFAULT_BOARD, [item('a', 2)], sources);
    client.update(DEFAULT_BOARD, [item('a', 3)], sources);
    expect(worker.solves()).toHaveLength(1);
    worker.reply({ type: 'result', seq: 1, result: empty });
    expect(results).toHaveLength(1);
    const solves = worker.solves();
    expect(solves).toHaveLength(2);
    expect(solves[1]?.items[0]?.pose.x).toBe(3);
    worker.reply({ type: 'result', seq: 2, result: empty });
    expect(worker.solves()).toHaveLength(2);
  });

  test('a repeated answer for the same seq (late solid definition) is applied, not queued again', () => {
    const { worker, results, client } = setup();
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    worker.reply({ type: 'result', seq: 1, result: empty });
    worker.reply({ type: 'result', seq: 1, result: { ...empty, pending: ['x'] } });
    expect(results).toHaveLength(2);
    expect(worker.solves()).toHaveLength(1);
  });

  test('a failed solve frees the slot: the newest queued scene is sent, not stuck forever', () => {
    const { worker, client } = setup();
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    client.update(DEFAULT_BOARD, [item('a', 2)], sources);
    expect(worker.solves()).toHaveLength(1);
    worker.reply({ type: 'error', seq: 1, message: 'solve failed' });
    const solves = worker.solves();
    expect(solves).toHaveLength(2);
    expect(solves[1]?.items[0]?.pose.x).toBe(2);
  });

  test('a notice or a stale error never frees a solve that is still running', () => {
    const { worker, client } = setup();
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    client.update(DEFAULT_BOARD, [item('a', 2)], sources);
    worker.reply({ type: 'notice', message: 'GLB 404' });
    worker.reply({ type: 'error', seq: 0, message: 'old failure' });
    expect(worker.solves()).toHaveLength(1);
  });

  test('a scene that cannot be posted is reported and does not wedge the client', () => {
    const worker = new FakeWorker();
    const errors: string[] = [];
    const client = new InvalidZoneClient(
      () => worker,
      () => undefined,
      (m) => errors.push(m),
    );
    worker.failNextPost = true;
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    expect(errors[0]).toContain('DataCloneError');
    client.update(DEFAULT_BOARD, [item('a', 2)], sources);
    expect(worker.solves()).toHaveLength(1);
    expect(worker.solves()[0]?.seq).toBe(1);
  });

  test('a solid that cannot be posted is reported and retried on the next update', () => {
    const worker = new FakeWorker();
    const errors: string[] = [];
    const real = worker.postMessage.bind(worker);
    let failDefine = true;
    worker.postMessage = (message) => {
      if (failDefine && message.type === 'define') {
        failDefine = false;
        throw new Error('DataCloneError');
      }
      real(message);
    };
    const client = new InvalidZoneClient(
      () => worker,
      () => undefined,
      (m) => errors.push(m),
    );
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    expect(errors[0]).toContain('could not be sent');
    client.update(DEFAULT_BOARD, [item('a', 2)], sources);
    expect(worker.sent.filter((m) => m.type === 'define')).toHaveLength(1);
  });

  test('a worker script failure is surfaced', () => {
    const worker = new FakeWorker();
    const errors: string[] = [];
    new InvalidZoneClient(
      () => worker,
      () => undefined,
      (m) => errors.push(m),
    );
    worker.onerror?.(new ErrorEvent('error', { message: 'import failed' }));
    expect(errors).toEqual(['worker failed: import failed']);
  });

  test('a fatal worker error is surfaced without re-sending into the dead worker', () => {
    const worker = new FakeWorker();
    const errors: string[] = [];
    const client = new InvalidZoneClient(
      () => worker,
      () => undefined,
      (m) => errors.push(m),
    );
    client.update(DEFAULT_BOARD, [item('a', 1)], sources);
    client.update(DEFAULT_BOARD, [item('a', 2)], sources);
    worker.reply({ type: 'fatal', message: 'no wasm' });
    expect(errors).toEqual(['no wasm']);
    expect(worker.solves()).toHaveLength(1);
  });

  test('worker errors are surfaced and dispose terminates the worker', () => {
    const worker = new FakeWorker();
    const errors: string[] = [];
    const client = new InvalidZoneClient(
      () => worker,
      () => undefined,
      (m) => errors.push(m),
    );
    worker.reply({ type: 'notice', message: 'boom' });
    expect(errors).toEqual(['boom']);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });
});
