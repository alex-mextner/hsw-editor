import { beforeAll, describe, expect, test } from 'bun:test';
import { DEFAULT_BOARD, PoseSchema } from '@hsw-editor/core';
import { InvalidZoneEngine, type EngineItem, type SolidMesh } from './engine.ts';
import { loadManifold, type ManifoldToplevel } from './manifold.ts';
import type { FromWorker, SolidSource } from './protocol.ts';
import { WorkerCore } from './workerCore.ts';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

const box = { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 20 } };
const boxSource: SolidSource = { kind: 'box', box };
const glb = (name: string): SolidSource => ({ kind: 'glb', url: name, fallbackBox: box });
const item = (id: string, solidKey: string, x: number): EngineItem => ({
  id,
  kind: 'holder',
  solidKey,
  pose: PoseSchema.parse({ x, y: 100 }),
});
const cube: SolidMesh = {
  positions: Float32Array.from([
    -10, -10, 0, 10, -10, 0, 10, 10, 0, -10, 10, 0, -10, -10, 20, 10, -10, 20, 10, 10, 20, -10, 10,
    20,
  ]),
  indices: Uint32Array.from([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ]),
};

function setup(overrides: Partial<ConstructorParameters<typeof WorkerCore>[0]> = {}) {
  const posted: FromWorker[] = [];
  const scheduled: (() => void)[] = [];
  const delays: number[] = [];
  const core = new WorkerCore({
    engine: Promise.resolve(new InvalidZoneEngine(wasm)),
    post: (message) => posted.push(message),
    fetchSolid: async () => cube,
    schedule: (task, delayMs) => {
      scheduled.push(task);
      delays.push(delayMs);
    },
    ...overrides,
  });
  const results = () => posted.filter((m) => m.type === 'result');
  return { core, posted, scheduled, delays, results };
}

describe('WorkerCore', () => {
  test('answers a solve with the seq it carries', async () => {
    const { core, results } = setup();
    core.handle({ type: 'define', key: 'cube', source: boxSource });
    core.handle({
      type: 'solve',
      seq: 7,
      board: DEFAULT_BOARD,
      items: [item('a', 'cube', 100), item('b', 'cube', 110)],
    });
    await core.idle();
    const [answer] = results();
    expect(answer?.type === 'result' && answer.seq).toBe(7);
    expect(answer?.type === 'result' && answer.result.reasons).toHaveLength(2);
  });

  test('a slow GLB download does not hold up a solve: it is answered at once with the solid pending', async () => {
    let finish: (mesh: SolidMesh) => void = () => undefined;
    const slow = new Promise<SolidMesh>((resolve) => (finish = resolve));
    const { core, scheduled, results } = setup({ fetchSolid: () => slow });
    core.handle({ type: 'define', key: 'm1', source: glb('m1') });
    core.handle({
      type: 'solve',
      seq: 1,
      board: DEFAULT_BOARD,
      items: [item('a', 'm1', 100), item('b', 'm1', 110)],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [first] = results();
    expect(first?.type === 'result' && first.result.pending).toEqual(['m1']);
    finish(cube);
    await core.idle();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await core.idle();
    const last = results().at(-1);
    expect(last?.type === 'result' && last.result.reasons).toHaveLength(2);
  });

  test('re-solves once, after the last pending solid lands, not once per solid', async () => {
    const { core, scheduled, results } = setup();
    core.handle({
      type: 'solve',
      seq: 1,
      board: DEFAULT_BOARD,
      items: [item('a', 'm1', 100), item('b', 'm2', 110), item('c', 'm3', 120)],
    });
    for (const key of ['m1', 'm2', 'm3']) core.handle({ type: 'define', key, source: glb(key) });
    await core.idle();
    expect(results()).toHaveLength(1); // the first, partial answer
    expect(scheduled).toHaveLength(1); // one debounced re-solve for three definitions
    scheduled[0]?.();
    await core.idle();
    const answers = results();
    expect(answers).toHaveLength(2);
    const last = answers[1];
    expect(last?.type === 'result' && last.result.pending).toEqual([]);
    expect(last?.type === 'result' && last.result.reasons.length).toBeGreaterThan(0);
  });

  test('a solid nobody ever defines does not hold back the re-solve for the others', async () => {
    const { core, scheduled, results } = setup();
    core.handle({
      type: 'solve',
      seq: 1,
      board: DEFAULT_BOARD,
      items: [item('a', 'm1', 100), item('b', 'm1', 110), item('c', 'never', 300)],
    });
    core.handle({ type: 'define', key: 'm1', source: glb('m1') });
    await core.idle();
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await core.idle();
    const last = results().at(-1);
    expect(last?.type === 'result' && last.result.pending).toEqual(['never']);
    expect(last?.type === 'result' && last.result.reasons).toHaveLength(2);
  });

  test('a hung download does not keep the solids that landed unchecked beyond a bounded wait', async () => {
    const { core, scheduled, delays, results } = setup({
      fetchSolid: (url) =>
        url === 'hung' ? new Promise<SolidMesh>(() => undefined) : Promise.resolve(cube),
    });
    core.handle({
      type: 'solve',
      seq: 1,
      board: DEFAULT_BOARD,
      items: [item('a', 'm1', 100), item('b', 'm1', 110), item('c', 'm2', 300)],
    });
    core.handle({ type: 'define', key: 'm2', source: glb('hung') });
    core.handle({ type: 'define', key: 'm1', source: glb('m1') });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduled).toHaveLength(1);
    expect(delays[0]).toBeGreaterThan(20); // bounded wait while a download is still in flight
    scheduled[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const last = results().at(-1);
    expect(last?.type === 'result' && last.result.reasons).toHaveLength(2);
    expect(last?.type === 'result' && last.result.pending).toEqual(['m2']);
  });

  test('a model that is not a closed solid is announced as approximated by its box', async () => {
    const open: SolidMesh = {
      positions: Float32Array.from([-10, -10, 0, 10, -10, 0, 10, 10, 20, -10, 10, 20]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    };
    const { core, posted } = setup({ fetchSolid: async () => open });
    core.handle({ type: 'define', key: 'm1', source: glb('m1') });
    await core.idle();
    expect(
      posted.some((m) => m.type === 'notice' && m.message.includes('bounding box stands in')),
    ).toBe(true);
  });

  test('a GLB without triangles falls back to the bounding box instead of an inverted solid', async () => {
    const empty: SolidMesh = { positions: new Float32Array(0), indices: new Uint32Array(0) };
    const { core, posted, scheduled, results } = setup({ fetchSolid: async () => empty });
    core.handle({
      type: 'solve',
      seq: 1,
      board: DEFAULT_BOARD,
      items: [item('a', 'm1', 100), item('b', 'm1', 110)],
    });
    core.handle({ type: 'define', key: 'm1', source: glb('m1') });
    await core.idle();
    expect(posted.some((m) => m.type === 'notice' && m.message.includes('no triangles'))).toBe(
      true,
    );
    scheduled[0]?.();
    await core.idle();
    const last = results().at(-1);
    expect(last?.type === 'result' && last.result.reasons).toHaveLength(2);
  });

  test('a failed GLB fetch is reported and the bounding box stands in', async () => {
    const { core, posted, scheduled, results } = setup({
      fetchSolid: async () => {
        throw new Error('404');
      },
    });
    core.handle({
      type: 'solve',
      seq: 1,
      board: DEFAULT_BOARD,
      items: [item('a', 'm1', 100), item('b', 'm1', 110)],
    });
    core.handle({ type: 'define', key: 'm1', source: glb('m1') });
    await core.idle();
    expect(posted.some((m) => m.type === 'notice' && m.message.includes('404'))).toBe(true);
    scheduled[0]?.();
    await core.idle();
    const last = results().at(-1);
    expect(last?.type === 'result' && last.result.reasons).toHaveLength(2);
  });

  test('a throwing solve is reported as a non-fatal error and the next solve still works', async () => {
    const engine = new InvalidZoneEngine(wasm);
    engine.defineSolid('cube', { kind: 'box', box });
    const realSolve = engine.solve.bind(engine);
    let failures = 1;
    engine.solve = (board, items) => {
      if (failures-- > 0) throw new Error('wasm abort');
      return realSolve(board, items);
    };
    const { core, posted, results } = setup({ engine: Promise.resolve(engine) });
    core.handle({ type: 'solve', seq: 1, board: DEFAULT_BOARD, items: [item('a', 'cube', 100)] });
    core.handle({ type: 'solve', seq: 2, board: DEFAULT_BOARD, items: [item('a', 'cube', 100)] });
    await core.idle();
    expect(posted[0]).toEqual({ type: 'error', seq: 1, message: 'wasm abort' });
    expect(results()).toHaveLength(1);
    expect(results()[0]?.type === 'result' && results()[0]?.seq).toBe(2);
  });

  test('a failed engine load is one fatal error and later messages are ignored', async () => {
    const { core, posted } = setup({ engine: Promise.reject(new Error('no wasm')) });
    core.handle({ type: 'solve', seq: 1, board: DEFAULT_BOARD, items: [] });
    core.handle({ type: 'define', key: 'x', source: boxSource });
    await core.idle();
    expect(posted).toEqual([{ type: 'fatal', message: 'manifold failed to load: no wasm' }]);
  });
});
