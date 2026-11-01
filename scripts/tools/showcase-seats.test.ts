import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HolderSpec } from '../../packages/compat/src/index.ts';
import type { LeafOp, Op, Pose } from '../../packages/core/src/index.ts';
import { seatOps } from '../../packages/physics/src/seatPlan.ts';
import '../../packages/tools/src/classes/index.ts';
import { ToolAssetStore } from '../../packages/tools/src/node/assets.ts';
import { SHOWCASE_LAYOUT, type ShowcaseHolder } from '../../apps/web/src/demo/showcaseLayout.ts';
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
let specs: Map<string, HolderSpec>;
let index: Awaited<ReturnType<ToolAssetStore['index']>>;

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
  specs = new Map<string, HolderSpec>(
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
  index = await new ToolAssetStore(join(root, 'assets'), undefined, classIds).index();
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
    // What is left of the hang verdicts is a swinging blade (the scissors hang by one handle): no tool floats, tips, jams or pokes
    // out of its rack. The removal verdicts (a tool that has to be tilted, fingers that are cramped) are a separate question.
    const hangProblems = after.tools.flatMap((tool) =>
      tool.problems
        .filter((problem) => HANG_CODES.has(problem.code))
        .map((problem) => `${tool.toolId}:${problem.code}`),
    );
    expect(hangProblems).toEqual(['sc-scissors-t0:swings', 'sc-scissors-t0:needs_retention']);
  }, 300_000);
});

/** The showcase as it was before the holder/tool pairing of #258: the refit rail with default screwdrivers, long-nose pliers at full length. */
const OLD_PAIRING: readonly ShowcaseHolder[] = SHOWCASE_LAYOUT.map((holder) => {
  if (holder.id === 'sc-drivers') {
    return {
      ...holder,
      bankId: 'refit-screwdriver-rail-3',
      tools: holder.tools.map((tool) => ({
        classId: tool.classId,
        params: { handleDiameter: 22 },
      })),
    };
  }
  if (holder.id === 'sc-pliers') {
    return { ...holder, tools: holder.tools.map((tool) => ({ classId: tool.classId })) };
  }
  return holder;
});

/** Where the old seat search (lowest centre of gravity, no look at what stops the tool) put those tools on the user's wall. */
const OLD_SEATS: Readonly<Record<string, Pose>> = {
  'sc-drivers-t0': { x: 138, y: 243, z: 29, rotX: 0, rotY: 0, rotZ: 180 },
  'sc-drivers-t1': { x: 174, y: 165, z: 32, rotX: 182, rotY: 90, rotZ: 0 },
  'sc-drivers-t2': { x: 210, y: 162, z: 34, rotX: 3, rotY: 0, rotZ: 180 },
  'sc-pliers-t0': { x: 162, y: 509, z: 31, rotX: 0, rotY: 90, rotZ: 180 },
  'sc-pliers-t1': { x: 194, y: 458, z: 28, rotX: 0, rotY: 90, rotZ: 180 },
};

/** What the hang analysis can object to (removal ergonomics are another question). */
const HANG_CODES: ReadonlySet<string> = new Set([
  'levitating',
  'penetrates',
  'falls',
  'tips',
  'swings',
  'slides_off',
  'needs_retention',
  'wedged',
  'protrudes',
  'overloaded',
]);

/** Builds the wall `id`, applies `ops` after it and returns the hang problem codes per tool id. */
async function hangCodes(
  id: string,
  built: SeatedShowcase,
  ops: readonly LeafOp[],
): Promise<Map<string, string[]>> {
  expect((await post('/api/walls', { id, name: id })).status).toBe(201);
  const setup: Op[] = [
    ...built.wall.models.map((model): Op => ({ type: 'addModelRef', model })),
    ...built.wall.items.map((item): Op => ({ type: 'addItem', item })),
    { type: 'batch', label: 'seats', ops: [...ops] },
  ];
  expect((await post(`/api/walls/${id}/ops`, { ops: setup })).status).toBe(200);
  const view = (await (
    await fetch(`${running.url}/api/walls/${id}/physics`)
  ).json()) as WallPhysicsView;
  return new Map(
    view.tools.map((tool) => [
      tool.toolId,
      tool.problems.map((problem) => problem.code).filter((code) => HANG_CODES.has(code)),
    ]),
  );
}

describe('seat cleanliness (#258): tools enter holes and slots cleanly and sit stably', () => {
  let clean: Map<string, string[]>;
  let old: Map<string, string[]>;
  let searched: Map<string, string[]>;

  beforeAll(async () => {
    clean = await hangCodes('clean', seated, seated.seats.ops);
    const oldBuilt = await seatShowcase(OLD_PAIRING, specs, index);
    old = await hangCodes(
      'old',
      oldBuilt,
      Object.entries(OLD_SEATS).flatMap(([toolId, pose]) => seatOps(toolId, pose).ops),
    );
    searched = await hangCodes('searched', oldBuilt, oldBuilt.seats.ops);
  }, 300_000);

  const codes = (view: Map<string, string[]>, toolId: string): string[] => {
    const found = view.get(toolId);
    if (found === undefined) throw new Error(`${toolId} is not in the view`);
    return found;
  };

  test('screwdriver jammed in a too-small hole of the old rail is no longer called stable (the jam itself is `wedged`, see seatFit.test.ts)', () => {
    // The poses are the old search's, rounded to the millimetre: at the edge of a hole that is the difference between a jam and a
    // millimetre of penetration; either way the physics flags it.
    expect(codes(old, 'sc-drivers-t0')).not.toEqual([]);
  });

  test('screwdrivers go through the holes of the 5 mm rail with the handle on the rim: nothing flagged', () => {
    for (const id of ['sc-drivers-t0', 'sc-drivers-t1', 'sc-drivers-t2']) {
      expect(codes(clean, id)).toEqual([]);
    }
  });

  test('the seat search no longer jams the screwdrivers in the old rail, nor wedges the long-nose pliers', () => {
    for (const id of ['sc-drivers-t0', 'sc-drivers-t1', 'sc-drivers-t2']) {
      expect(codes(searched, id)).toEqual([]);
    }
    expect(codes(searched, 'sc-pliers-t1')).not.toContain('wedged');
  });

  test('long-nose pliers poking out below the 66 mm rack are flagged protrudes; sized to the rack they sit inside it', () => {
    expect(codes(old, 'sc-pliers-t1')).toContain('protrudes');
    expect(codes(clean, 'sc-pliers-t1')).toEqual([]);
  });

  test('the drill standing on its battery on the U-shelf leans back and is held against a pull', () => {
    expect(codes(clean, 'sc-drill-t0')).toEqual([]);
  });

  test('the open-end wrench in the 4-slot rack neither tips nor sinks into a slot', () => {
    for (const id of ['sc-wrench-t0', 'sc-wrench-t1', 'sc-wrench-t2']) {
      expect(codes(clean, id)).toEqual([]);
    }
  });

  test('no tool of the seated demo wall is wedged or pokes out of its rack', () => {
    const flagged = [...clean].flatMap(([id, found]) =>
      found.filter((code) => ['wedged', 'protrudes'].includes(code)).map((code) => `${id}:${code}`),
    );
    expect(flagged).toEqual([]);
  });
});
