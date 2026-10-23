/** Wall physics on the real daemon: seed holders, generated tools, REST routes and the `wall_analyse_hang` host tool. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountSlots, type HolderSpec } from '@hsw-editor/compat';
import type { Wall, WallResponse } from '@hsw-editor/core';
import { SolidBody, placementOfPose, seatTool } from '@hsw-editor/physics';
import { testConfig } from '../omp/testing/harness.ts';
import { createWallToolFactory } from '../omp/wall-tools.ts';
import { startServer, type RunningServer } from '../server.ts';
import { PhysicsAssets } from './assets.ts';
import { describeProblemEn } from './describe.ts';
import type { WallPhysicsView } from './service.ts';

const HOLDER = 'screwdriver-rail-slots6-holediameter5';
const DRIVER_PARAMS = { shaftDiameter: 4, tipWidth: 4 };
const HOLDER_POSE = { x: 300, y: 300, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
/** The second holder, far from the first so the tools are not each other's obstacles. */
const SECOND_X = 700;
/** Well clear of the rail: the screwdriver (about 200 mm long) hangs in the air. */
const LIFT_MM = 300;

let root: string;
let running: RunningServer;
let home: string;
let seatedPose: { x: number; y: number; z: number; rotX: number; rotY: number; rotZ: number };
let wallRev = 0;
let savedBankDir: string | undefined;

async function post(path: string, body: object): Promise<Response> {
  return fetch(`${running.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const driverModel = {
  type: 'addModelRef',
  model: {
    id: 'm-driver',
    label: 'Screwdriver',
    status: 'chosen',
    source: { type: 'library', by: 'gen:screwdriver' },
    toolClass: 'screwdriver',
  },
} as const;

function holderItem(id: string, x: number): object {
  return {
    type: 'addItem',
    item: {
      id,
      kind: 'holder',
      bankId: HOLDER,
      pose: { ...HOLDER_POSE, x },
      source: { type: 'agent' },
    },
  };
}

function driverItem(id: string, pose: object, parentId?: string): object {
  return {
    type: 'addItem',
    item: {
      id,
      kind: 'tool',
      modelRefId: 'm-driver',
      toolClass: 'screwdriver',
      ...(parentId === undefined ? {} : { parentId }),
      params: DRIVER_PARAMS,
      pose,
      source: { type: 'agent' },
    },
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-physics-'));
  home = join(root, 'home');
  savedBankDir = process.env['HSW_BANK_DIR'];
  delete process.env['HSW_BANK_DIR'];
  running = await startServer({
    port: 0,
    host: '127.0.0.1',
    home,
    webDist: join(root, 'dist'),
    allowedOrigins: [],
    heartbeatMs: 1000,
  });
  expect((await post('/api/walls', { id: 'hang', name: 'Hang' })).status).toBe(201);

  // The pose the tool really comes to rest in: lowered into the rail by `seatTool` on the real holder mesh.
  const assets = new PhysicsAssets(home);
  const loaded = await assets.elementSolid(HOLDER, {});
  if (loaded === null) throw new Error(`the seed has no ${HOLDER}`);
  const spec: HolderSpec = {
    id: HOLDER,
    category: loaded.element.category,
    fitsTool: loaded.element.fitsTool,
    bboxMm: loaded.element.bboxMm,
  };
  const slot = mountSlots(spec, spec.fitsTool[0] ?? null)[0];
  if (slot === undefined) throw new Error('the holder has no slot');
  const probeWall = (await (
    await post('/api/walls', { id: 'probe', name: 'Probe' })
  ).json()) as WallResponse;
  const probe: Wall = {
    ...probeWall.wall,
    models: [{ ...driverModel.model, source: { ...driverModel.model.source } }],
    items: [],
  };
  const built = await assets.toolBody(
    {
      id: 'probe',
      kind: 'tool',
      toolClass: 'screwdriver',
      modelRefId: 'm-driver',
      params: DRIVER_PARAMS,
      pose: HOLDER_POSE,
      source: { type: 'agent' },
      locked: false,
    },
    probe,
  );
  if ('skip' in built) throw new Error(`no screwdriver body: ${built.skip}`);
  const placement = placementOfPose(HOLDER_POSE);
  const seat = seatTool({
    tool: built.body,
    holder: new SolidBody(HOLDER, loaded.solid, placement.rotation, placement.position),
    neighbours: [],
    anchor: [HOLDER_POSE.x + slot.anchor[0], HOLDER_POSE.y + slot.anchor[1], slot.anchor[2]],
    halfWidthMm: 14,
    tipDown: true,
  });
  if (seat === null) throw new Error('the screwdriver cannot be seated in the rail');
  seatedPose = seat.pose;

  const applied = await post('/api/walls/hang/ops', {
    ops: [
      driverModel,
      holderItem('h-1', HOLDER_POSE.x),
      holderItem('h-2', SECOND_X),
      driverItem('t-seated', seatedPose, 'h-1'),
      driverItem(
        't-floating',
        { ...seatedPose, x: seatedPose.x - HOLDER_POSE.x + SECOND_X, y: seatedPose.y + LIFT_MM },
        'h-2',
      ),
      driverItem('t-loose', { ...seatedPose, x: 1000 }),
    ],
  });
  expect(applied.status).toBe(200);
  const appliedBody = (await applied.json()) as { rev: number };
  wallRev = appliedBody.rev;
}, 120_000);

afterAll(async () => {
  await running.stop();
  if (savedBankDir !== undefined) process.env['HSW_BANK_DIR'] = savedBankDir;
  rmSync(root, { recursive: true, force: true });
});

async function report(path: string): Promise<{ status: number; body: WallPhysicsView }> {
  const response = await fetch(`${running.url}${path}`);
  return { status: response.status, body: (await response.json()) as WallPhysicsView };
}

const FALLING = ['levitating', 'falls', 'penetrates'];

describe('wall physics service over REST', () => {
  test('a tool floating above its holder is flagged, the seated one is not', async () => {
    const started = performance.now();
    const { status, body } = await report('/api/walls/hang/physics');
    expect(status).toBe(200);
    expect(body.wallId).toBe('hang');
    expect(body.rev).toBe(wallRev);
    const seated = body.tools.find((t) => t.toolId === 't-seated');
    const floating = body.tools.find((t) => t.toolId === 't-floating');
    if (seated === undefined || floating === undefined) throw new Error('both tools are analysed');
    expect(seated.holderId).toBe('h-1');
    expect(seated.problems.filter((p) => FALLING.includes(p.code))).toEqual([]);
    expect(seated.status).not.toBe('unstable');
    // manifold-3d is loaded, so removal is judged too
    expect(seated.removal).not.toBeNull();
    expect(floating.status).toBe('unstable');
    const falling = floating.problems.find((p) => FALLING.includes(p.code));
    expect(falling?.severity).toBe('error');
    expect(falling?.text.length).toBeGreaterThan(10);
    expect(floating.score).toBeLessThan(seated.score);
    expect(body.flagged).toBeGreaterThanOrEqual(1);
    expect(performance.now() - started).toBeLessThan(30_000);
  }, 60_000);

  test('a tool without a holder is listed as skipped, not judged', async () => {
    const { body } = await report('/api/walls/hang/physics');
    expect(body.skipped).toEqual([{ toolId: 't-loose', reason: 'no_holder' }]);
    expect(body.tools.map((t) => t.toolId).sort()).toEqual(['t-floating', 't-seated']);
  });

  test('one tool can be asked for by itself and agrees with the whole-wall report', async () => {
    const whole = await report('/api/walls/hang/physics');
    const one = await report('/api/walls/hang/items/t-floating/physics');
    expect(one.status).toBe(200);
    expect(one.body.tools).toHaveLength(1);
    expect(one.body.tools[0]?.status).toBe(
      whole.body.tools.find((t) => t.toolId === 't-floating')?.status,
    );
  });

  test('unknown wall or item is 404, an item that is not a hung tool is 409, other methods 405', async () => {
    expect((await report('/api/walls/nope/physics')).status).toBe(404);
    expect((await report('/api/walls/hang/items/nope/physics')).status).toBe(404);
    const holder = await fetch(`${running.url}/api/walls/hang/items/h-1/physics`);
    expect(holder.status).toBe(409);
    expect(((await holder.json()) as { error: { code: string } }).error.code).toBe(
      'not_a_hung_tool',
    );
    const loose = await fetch(`${running.url}/api/walls/hang/items/t-loose/physics`);
    expect(loose.status).toBe(409);
    expect((await post('/api/walls/hang/physics', {})).status).toBe(405);
  });
});

describe('wall_analyse_hang host tool', () => {
  function tool() {
    const factory = createWallToolFactory({ apiBase: () => running.url });
    const found = factory({
      wallId: 'hang',
      config: testConfig(),
      viewport: {
        async call() {
          throw new Error('no editor window');
        },
      },
      prompts: {
        async ask() {
          return { cancelled: true };
        },
      },
    }).find((t) => t.definition.name === 'wall_analyse_hang');
    if (found === undefined) throw new Error('wall_analyse_hang is not registered');
    return found;
  }
  const context = { wallId: 'hang', signal: new AbortController().signal };

  test('returns the report of the wall, and of one tool with itemId', async () => {
    const whole = await tool().execute({}, context);
    expect(whole.isError).toBeUndefined();
    const text = whole.content[0];
    const parsed = JSON.parse(text?.type === 'text' ? text.text : '{}') as WallPhysicsView;
    expect(parsed.tools.map((t) => t.toolId).sort()).toEqual(['t-floating', 't-seated']);
    const one = await tool().execute({ itemId: 't-floating' }, context);
    const oneText = one.content[0];
    const single = JSON.parse(oneText?.type === 'text' ? oneText.text : '{}') as WallPhysicsView;
    expect(single.tools).toHaveLength(1);
  }, 60_000);

  test('a refused item comes back as a tool error with the server code', async () => {
    const failed = await tool().execute({ itemId: 'h-1' }, context);
    expect(failed.isError).toBe(true);
    const text = failed.content[0];
    expect(text?.type === 'text' ? text.text : '').toContain('not_a_hung_tool');
  });
});

describe('describeProblemEn', () => {
  test('writes one sentence per code from its parameters', () => {
    expect(
      describeProblemEn({ code: 'levitating', severity: 'error', params: { gapMm: 42 } }),
    ).toContain('42 mm');
    expect(
      describeProblemEn({ code: 'levitating', severity: 'error', params: { gapMm: -1 } }),
    ).toContain('air');
    expect(
      describeProblemEn({
        code: 'overloaded',
        severity: 'error',
        params: { massG: 400, maxLoadG: 150 },
      }),
    ).toBe('Too heavy for its holder: 400 g against a rating of 150 g.');
    expect(
      describeProblemEn({
        code: 'removal_two_hands',
        severity: 'warning',
        params: { reasons: ['heavy', 'cramped'], path: 'lift' },
      }),
    ).toBe('Needs two hands to take off: it is heavy, there is little room for fingers beside it.');
    expect(
      describeProblemEn({
        code: 'removal_blocked',
        severity: 'error',
        params: { blockedBy: ['h-2'] },
      }),
    ).toBe('Cannot be taken off: blocked by h-2.');
    expect(
      describeProblemEn({
        code: 'swings',
        severity: 'warning',
        params: { swingDeg: 17, swayMm: 40 },
      }),
    ).toBe('Swings freely (about 17° when bumped, about 40 mm sideways).');
  });
});
