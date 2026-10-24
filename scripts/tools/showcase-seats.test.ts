import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HolderSpec } from '../../packages/compat/src/index.ts';
import type { Op } from '../../packages/core/src/index.ts';
import '../../packages/tools/src/classes/index.ts';
import { ToolAssetStore } from '../../packages/tools/src/node/assets.ts';
import { SHOWCASE_LAYOUT } from '../../apps/web/src/demo/showcaseLayout.ts';
import { startServer, type RunningServer } from '../../apps/server/src/server.ts';
import type { WallPhysicsView } from '../../apps/server/src/physics/service.ts';
import { seatShowcase, type SeatedShowcase } from './showcase-seats.ts';

const SEED = resolve(import.meta.dir, '../../packages/bank/seed/index.json');

interface SeedElement {
  id: string;
  category: string;
  bboxMm: HolderSpec['bboxMm'];
  fitsTool?: HolderSpec['fitsTool'];
}

let root: string;
let running: RunningServer;
let savedBankDir: string | undefined;
let seated: SeatedShowcase;

async function post(path: string, body: object): Promise<Response> {
  return fetch(`${running.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function analyse(): Promise<WallPhysicsView> {
  return (await (await fetch(`${running.url}/api/walls/demo/physics`)).json()) as WallPhysicsView;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-showcase-seats-'));
  savedBankDir = process.env['HSW_BANK_DIR'];
  delete process.env['HSW_BANK_DIR'];
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { elements: SeedElement[] };
  const specs = new Map<string, HolderSpec>(
    seed.elements.map((element) => [
      element.id,
      {
        id: element.id,
        category: element.category,
        fitsTool: element.fitsTool ?? [],
        bboxMm: element.bboxMm,
      },
    ]),
  );
  const classIds = [
    ...new Set(SHOWCASE_LAYOUT.flatMap((holder) => holder.tools.map((tool) => tool.classId))),
  ];
  const index = await new ToolAssetStore(join(root, 'assets'), undefined, classIds).index();
  seated = await seatShowcase(SHOWCASE_LAYOUT, specs, index);

  running = await startServer({
    port: 0,
    host: '127.0.0.1',
    home: join(root, 'home'),
    webDist: join(root, 'dist'),
    allowedOrigins: [],
    heartbeatMs: 1000,
  });
  expect((await post('/api/walls', { id: 'demo', name: 'Demo' })).status).toBe(201);
  const setup: Op[] = [
    ...seated.wall.models.map((model): Op => ({ type: 'addModelRef', model })),
    ...seated.wall.items.map((item): Op => ({ type: 'addItem', item })),
  ];
  expect((await post('/api/walls/demo/ops', { ops: setup })).status).toBe(200);
}, 300_000);

afterAll(async () => {
  await running.stop();
  if (savedBankDir !== undefined) process.env['HSW_BANK_DIR'] = savedBankDir;
  rmSync(root, { recursive: true, force: true });
});

describe('the seated showcase (the demo wall)', () => {
  test('every tool of the layout has a seat, and the plan moves them all', () => {
    const tools = seated.wall.items.filter((item) => item.kind === 'tool');
    expect(seated.unhung).toEqual([]);
    expect(seated.seats.kept).toEqual([]);
    expect(seated.seats.seated + seated.seats.unchanged).toBe(tools.length);
    expect(seated.seats.ops.length).toBe(seated.seats.seated * 2);
  });

  test('before seating the physics flags the compatibility poses, after it no tool floats, sinks or falls', async () => {
    const unseated = (view: WallPhysicsView): string[] =>
      view.tools.flatMap((tool) =>
        tool.problems
          .filter((problem) => ['levitating', 'penetrates', 'falls'].includes(problem.code))
          .map((problem) => `${tool.toolId}:${problem.code}`),
      );
    const before = await analyse();
    // the demo page said "16 tools need attention": nearly every tool hung at its compatibility pose is flagged
    expect(before.flagged).toBeGreaterThanOrEqual(15);
    expect(unseated(before).length).toBeGreaterThan(10);

    const applied = await post('/api/walls/demo/ops', {
      ops: [{ type: 'batch', label: 'seat all', ops: seated.seats.ops }],
    });
    expect(applied.status).toBe(200);
    const after = await analyse();
    expect(after.tools).toHaveLength(seated.wall.items.filter((i) => i.kind === 'tool').length);
    expect(unseated(after)).toEqual([]);
    // what is left is the physics' honest verdict on a few tools (a wrench that tips, a swinging blade), not a seating gap
    expect(after.flagged).toBeLessThanOrEqual(3);
  }, 300_000);
});
