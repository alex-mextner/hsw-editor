import { beforeAll, describe, expect, test } from 'bun:test';
import type { TriMesh, ToolBody } from '@hsw-editor/physics';
import { loadManifold, type ManifoldToplevel } from '@/scene/invalid-zones/manifold.ts';
import { barTool, ORIGIN, slotBlockMesh } from './fakes.testkit.ts';
import type { FallRequest, FromWorker, PhysicsScene, RankRequest } from './protocol.ts';
import { WorkerCore } from './workerCore.ts';

let wasm: Promise<ManifoldToplevel>;
beforeAll(() => {
  wasm = loadManifold();
});

interface Harness {
  readonly core: WorkerCore;
  readonly posted: FromWorker[];
  readonly fetched: string[];
}

function harness(
  options: {
    readonly failTools?: ReadonlySet<string>;
    readonly noMass?: ReadonlySet<string>;
    readonly wasm?: Promise<ManifoldToplevel>;
  } = {},
): Harness {
  const posted: FromWorker[] = [];
  const fetched: string[] = [];
  const core = new WorkerCore({
    wasm: options.wasm ?? wasm,
    post: (message) => posted.push(message),
    fetchSolid: async (url): Promise<TriMesh> => {
      fetched.push(url);
      return slotBlockMesh();
    },
    fetchTool: async (url, id): Promise<ToolBody | null> => {
      fetched.push(url);
      if (options.failTools?.has(url)) throw new Error('503');
      if (options.noMass?.has(url)) return null;
      return barTool(id);
    },
  });
  return { core, posted, fetched };
}

const holder = { id: 'h1', bodyKey: 'block', pose: ORIGIN };
const scene = (toolY: number): PhysicsScene => ({
  holders: [holder],
  tools: [
    {
      id: 'bar',
      bodyKey: 'bar-model',
      pose: { ...ORIGIN, y: toolY, z: 10 },
      holderId: 'h1',
    },
  ],
  others: [],
});

function define(h: Harness): void {
  h.core.handle({ type: 'define', key: 'block', source: { kind: 'solid', url: 'u://block' } });
  h.core.handle({ type: 'define', key: 'bar-model', source: { kind: 'tool', url: 'u://bar' } });
}

function result(h: Harness): Extract<FromWorker, { type: 'result' }> {
  const found = h.posted.find((m) => m.type === 'result');
  if (found?.type !== 'result')
    throw new Error(`no result in ${JSON.stringify(h.posted.map((m) => m.type))}`);
  return found;
}

describe('WorkerCore solve', () => {
  test('a tool standing in the slot is fine, one floating above it falls', async () => {
    const h = harness();
    define(h);
    h.core.handle({ type: 'solve', seq: 1, scene: scene(4) });
    await h.core.idle();
    const seated = result(h);
    expect(seated.seq).toBe(1);
    expect(seated.report.tools).toHaveLength(1);
    expect(seated.report.tools[0]?.problems).toEqual([]);
    expect(seated.report.tools[0]?.removal?.verdict).toBe('free');

    const floating = harness();
    define(floating);
    floating.core.handle({ type: 'solve', seq: 1, scene: scene(24) });
    await floating.core.idle();
    const report = result(floating).report;
    expect(report.flagged).toBe(1);
    expect(report.tools[0]?.problems.map((p) => p.code)).toContain('falls');
  });

  test('a model is fetched once however often it is defined or solved', async () => {
    const h = harness();
    define(h);
    define(h);
    h.core.handle({ type: 'solve', seq: 1, scene: scene(4) });
    h.core.handle({ type: 'solve', seq: 2, scene: scene(4) });
    await h.core.idle();
    expect(h.fetched.sort()).toEqual(['u://bar', 'u://block']);
    expect(h.posted.filter((m) => m.type === 'result').map((m) => m.seq)).toEqual([1, 2]);
  });

  test('a tool whose model has no mass data is skipped for good, the others are still analysed', async () => {
    const h = harness({ noMass: new Set(['u://bar']) });
    define(h);
    h.core.handle({ type: 'solve', seq: 1, scene: scene(4) });
    await h.core.idle();
    const answer = result(h);
    expect(answer.skipped).toEqual(['bar']);
    expect(answer.report.tools).toEqual([]);
    expect(answer.missing).toEqual([{ key: 'bar-model', retry: false }]);
  });

  test('a failed download is reported as retryable and fetched again when defined again', async () => {
    const failing = new Set(['u://bar']);
    const h = harness({ failTools: failing });
    define(h);
    h.core.handle({ type: 'solve', seq: 1, scene: scene(4) });
    await h.core.idle();
    expect(result(h).missing).toEqual([{ key: 'bar-model', retry: true }]);
    expect(h.posted.some((m) => m.type === 'notice')).toBe(true);

    failing.clear();
    h.posted.length = 0;
    define(h);
    h.core.handle({ type: 'solve', seq: 2, scene: scene(4) });
    await h.core.idle();
    expect(result(h).missing).toEqual([]);
    expect(result(h).report.tools).toHaveLength(1);
  });

  test('a tool on a holder without a model is skipped', async () => {
    const h = harness();
    h.core.handle({ type: 'define', key: 'bar-model', source: { kind: 'tool', url: 'u://bar' } });
    h.core.handle({ type: 'solve', seq: 1, scene: scene(4) });
    await h.core.idle();
    expect(result(h).skipped).toEqual(['bar']);
  });

  test('a model evicted from the bounded cache is fetched again from its source when a wall needs it', async () => {
    const h = harness();
    define(h);
    for (let n = 0; n < 150; n += 1) {
      h.core.handle({
        type: 'define',
        key: `filler-${n}`,
        source: { kind: 'solid', url: `u://filler-${n}` },
      });
    }
    await h.core.idle();
    expect(h.fetched.filter((url) => url === 'u://block')).toHaveLength(1);
    h.core.handle({ type: 'solve', seq: 1, scene: scene(4) });
    await h.core.idle();
    expect(h.fetched.filter((url) => url === 'u://block')).toHaveLength(2);
    expect(result(h).report.tools).toHaveLength(1);
    expect(result(h).missing).toEqual([]);
  });

  test('a WASM that cannot load is a fatal message and an error per job', async () => {
    const broken = Promise.reject<ManifoldToplevel>(new Error('no wasm'));
    const h = harness({ wasm: broken });
    define(h);
    h.core.handle({ type: 'solve', seq: 7, scene: scene(4) });
    await h.core.idle();
    expect(h.posted.find((m) => m.type === 'fatal')).toBeDefined();
    expect(h.posted.find((m) => m.type === 'error')).toMatchObject({ seq: 7 });
  });
});

describe('WorkerCore rank', () => {
  const request = (removal: boolean): RankRequest => ({
    tool: { id: 'bar', bodyKey: 'bar-model' },
    candidates: [
      {
        holder,
        anchor: [0, 40, 10],
        halfWidthMm: 8,
        tipDown: false,
        compatScore: 0.9,
      },
    ],
    neighbours: [],
    removal,
  });

  test('the tool is seated in the slot of the candidate holder', async () => {
    const h = harness();
    define(h);
    h.core.handle({ type: 'rank', seq: 3, request: request(true) });
    await h.core.idle();
    const answer = h.posted.find((m) => m.type === 'ranked');
    if (answer?.type !== 'ranked') throw new Error('no answer');
    expect(answer.seq).toBe(3);
    const [best] = answer.seats;
    expect(best?.holderId).toBe('h1');
    expect(best?.seat.report.status).not.toBe('unstable');
    // Lowered onto the 4 mm slot floor, not left on top of the block (40 mm).
    expect(best?.seat.pose.y).toBeLessThan(10);
    expect(best?.removal).not.toBeNull();
  });

  test('without removal no WASM probe runs', async () => {
    const h = harness();
    define(h);
    h.core.handle({ type: 'rank', seq: 3, request: request(false) });
    await h.core.idle();
    const answer = h.posted.find((m) => m.type === 'ranked');
    if (answer?.type !== 'ranked') throw new Error('no answer');
    expect(answer.seats[0]?.removal).toBeNull();
  });

  test('a tool without a model answers with no seats', async () => {
    const h = harness({ noMass: new Set(['u://bar']) });
    define(h);
    h.core.handle({ type: 'rank', seq: 4, request: request(false) });
    await h.core.idle();
    const answer = h.posted.find((m) => m.type === 'ranked');
    expect(answer).toMatchObject({ type: 'ranked', seq: 4, seats: [] });
  });
});

describe('WorkerCore fall', () => {
  const request = (pose: FallRequest['tool']['pose']): FallRequest => ({
    tool: { id: 'bar', bodyKey: 'bar-model', pose },
    neighbours: [holder],
    floorYMm: -250,
    floorDepthMm: 700,
  });
  const fell = (h: Harness): Extract<FromWorker, { type: 'fell' }> => {
    const found = h.posted.find((m) => m.type === 'fell');
    if (found?.type !== 'fell') throw new Error('no fell answer');
    return found;
  };

  test('a tool let go in mid air falls to the floor and lies there, as a pose the wall can store', async () => {
    const h = harness();
    define(h);
    h.core.handle({ type: 'fall', seq: 5, request: request({ ...ORIGIN, x: 200, y: 400, z: 40 }) });
    await h.core.idle();
    const answer = fell(h);
    expect(answer.seq).toBe(5);
    expect(answer.plan?.falls).toBe(true);
    if (answer.plan?.falls !== true) return;
    expect(answer.plan.landedOn).toBeNull();
    // the bar is 200 mm long: lying on its side, its origin is within a few mm of the floor
    expect(answer.plan.rest.y).toBeLessThan(-250 + 25);
    expect(answer.plan.rest.y).toBeGreaterThan(-250 - 25);
    expect(answer.plan.dropMm).toBeGreaterThan(500);
  });

  test('a tool standing in the slot of the holder stays', async () => {
    const h = harness();
    define(h);
    h.core.handle({ type: 'fall', seq: 6, request: request({ ...ORIGIN, y: 4, z: 10 }) });
    await h.core.idle();
    expect(fell(h).plan).toMatchObject({ falls: false });
  });

  test('a tool whose model has no mass data gets no plan', async () => {
    const h = harness({ noMass: new Set(['u://bar']) });
    define(h);
    h.core.handle({ type: 'fall', seq: 7, request: request({ ...ORIGIN, y: 400, z: 40 }) });
    await h.core.idle();
    expect(fell(h)).toMatchObject({ seq: 7, plan: null });
  });
});
