import { describe, expect, test } from 'bun:test';
import type { WallPhysicsReport } from '@hsw-editor/physics';
import { type WorkerPort, PhysicsClient } from './client.ts';
import type {
  BodySource,
  FallRequest,
  FromWorker,
  PhysicsScene,
  RankRequest,
  ToWorker,
} from './protocol.ts';
import { fakeSeat } from './testWall.testkit.ts';
import { ORIGIN } from './fakes.testkit.ts';

class FakeWorker implements WorkerPort {
  sent: ToWorker[] = [];
  terminated = false;
  failPost: ((message: ToWorker) => boolean) | null = null;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage(message: ToWorker): void {
    if (this.failPost?.(message) === true) throw new Error('DataCloneError');
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(message: FromWorker): void {
    this.onmessage?.(new MessageEvent('message', { data: message }));
  }
  of<T extends ToWorker['type']>(type: T): Extract<ToWorker, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ToWorker, { type: T }> => m.type === type);
  }
}

const REPORT: WallPhysicsReport = { tools: [], flagged: 0 };
const scene = (x: number): PhysicsScene => ({
  holders: [{ id: 'h', bodyKey: 'block', pose: { ...ORIGIN, x } }],
  tools: [{ id: 't', bodyKey: 'bar', pose: ORIGIN, holderId: 'h' }],
  others: [],
});
const sources = new Map<string, BodySource>([
  ['block', { kind: 'solid', url: 'u://block' }],
  ['bar', { kind: 'tool', url: 'u://bar' }],
]);
const answer = (
  seq: number,
  missing: Extract<FromWorker, { type: 'result' }>['missing'] = [],
): FromWorker => ({
  type: 'result',
  seq,
  report: REPORT,
  skipped: [],
  missing,
});

function setup() {
  const worker = new FakeWorker();
  const errors: string[] = [];
  const client = new PhysicsClient(
    () => worker,
    (m) => errors.push(m),
  );
  return { worker, errors, client };
}

describe('PhysicsClient.check', () => {
  test('defines every model once and solves', async () => {
    const { worker, client } = setup();
    const first = client.check(scene(0), sources);
    worker.reply(answer(1));
    expect((await first).report).toBe(REPORT);
    const second = client.check(scene(5), sources);
    worker.reply(answer(2));
    await second;
    expect(
      worker
        .of('define')
        .map((m) => m.key)
        .sort(),
    ).toEqual(['bar', 'block']);
    expect(worker.of('solve').map((m) => m.seq)).toEqual([1, 2]);
  });

  test('one check in flight: newer scenes wait, only the newest is sent, every caller gets its answer', async () => {
    const { worker, client } = setup();
    const a = client.check(scene(0), sources);
    const b = client.check(scene(1), sources);
    const c = client.check(scene(2), sources);
    expect(worker.of('solve')).toHaveLength(1);
    worker.reply(answer(1));
    await a;
    expect(worker.of('solve').map((m) => m.scene.holders[0]?.pose.x)).toEqual([0, 2]);
    worker.reply(answer(2));
    const [rb, rc] = await Promise.all([b, c]);
    expect(rb.report).toBe(REPORT);
    expect(rc.report).toBe(REPORT);
  });

  test('a failed check rejects its callers and frees the slot for the next scene', async () => {
    const { worker, errors, client } = setup();
    const a = client.check(scene(0), sources);
    const b = client.check(scene(1), sources);
    worker.reply({ type: 'error', seq: 1, message: 'boom' });
    await expect(a).rejects.toThrow('boom');
    expect(errors).toContain('boom');
    worker.reply(answer(2));
    await b;
  });

  test('a scene that cannot be cloned rejects and does not block later ones', async () => {
    const { worker, client } = setup();
    worker.failPost = (m) => m.type === 'solve';
    await expect(client.check(scene(0), sources)).rejects.toThrow('could not be sent');
    worker.failPost = null;
    const next = client.check(scene(1), sources);
    worker.reply(answer(2));
    await next;
  });

  test('a model that failed to download is defined again on the next check, a permanent gap is not', async () => {
    const { worker, client } = setup();
    const a = client.check(scene(0), sources);
    worker.reply(
      answer(1, [
        { key: 'bar', retry: true },
        { key: 'block', retry: false },
      ]),
    );
    await a;
    const b = client.check(scene(1), sources);
    worker.reply(answer(2));
    await b;
    expect(worker.of('define').map((m) => m.key)).toEqual(['block', 'bar', 'bar']);
  });

  test('a dead worker rejects everything waiting', async () => {
    const { worker, client } = setup();
    const a = client.check(scene(0), sources);
    const b = client.check(scene(1), sources);
    worker.reply({ type: 'fatal', message: 'manifold failed to load' });
    await expect(a).rejects.toThrow('manifold failed to load');
    await expect(b).rejects.toThrow('manifold failed to load');
  });

  test('dispose stops the worker and rejects later calls', async () => {
    const { worker, client } = setup();
    const pending = client.check(scene(0), sources);
    client.dispose();
    await expect(pending).rejects.toThrow('stopped');
    expect(worker.terminated).toBe(true);
    await expect(client.check(scene(0), sources)).rejects.toThrow('stopped');
  });
});

const request: RankRequest = {
  tool: { id: 't', bodyKey: 'bar' },
  candidates: [
    {
      holder: { id: 'h', bodyKey: 'block', pose: ORIGIN },
      anchor: [0, 0, 0],
      halfWidthMm: 5,
      tipDown: false,
      compatScore: 1,
    },
  ],
  neighbours: [],
  removal: false,
};

describe('PhysicsClient.rank', () => {
  test('answers by seq, independent of a wall check in flight', async () => {
    const { worker, client } = setup();
    const check = client.check(scene(0), sources);
    const ranked = client.rank(request, sources);
    expect(worker.of('rank')).toHaveLength(1);
    const seats = [fakeSeat('h', ORIGIN)];
    worker.reply({ type: 'ranked', seq: 2, seats, missing: [] });
    expect(await ranked).toBe(seats);
    worker.reply(answer(1));
    await check;
  });

  test('a failed rank rejects only itself', async () => {
    const { worker, client } = setup();
    const a = client.rank(request, sources);
    const b = client.rank(request, sources);
    worker.reply({ type: 'error', seq: 1, message: 'no seat' });
    await expect(a).rejects.toThrow('no seat');
    worker.reply({ type: 'ranked', seq: 2, seats: [], missing: [] });
    expect(await b).toEqual([]);
  });
});

describe('PhysicsClient.fall', () => {
  const fallRequest: FallRequest = {
    tool: { id: 't', bodyKey: 'bar', pose: ORIGIN },
    neighbours: [{ id: 'h', bodyKey: 'block', pose: ORIGIN }],
    floorYMm: -250,
    floorDepthMm: 700,
  };

  test('defines the models, sends the job and resolves with the plan of its seq', async () => {
    const { worker, client } = setup();
    const planned = client.fall(fallRequest, sources);
    expect(
      worker
        .of('define')
        .map((m) => m.key)
        .sort(),
    ).toEqual(['bar', 'block']);
    expect(worker.of('fall')).toEqual([{ type: 'fall', seq: 1, request: fallRequest }]);
    worker.reply({ type: 'fell', seq: 1, plan: null, missing: [] });
    expect(await planned).toBeNull();
  });

  test('a failed fall rejects only itself', async () => {
    const { worker, client } = setup();
    const a = client.fall(fallRequest, sources);
    const b = client.fall(fallRequest, sources);
    worker.reply({ type: 'error', seq: 1, message: 'no model' });
    await expect(a).rejects.toThrow('no model');
    worker.reply({ type: 'fell', seq: 2, plan: null, missing: [] });
    expect(await b).toBeNull();
  });

  test('a dead worker rejects a fall that is waiting', async () => {
    const { worker, client } = setup();
    const waiting = client.fall(fallRequest, sources);
    worker.reply({ type: 'fatal', message: 'wasm' });
    await expect(waiting).rejects.toThrow('wasm');
  });
});
