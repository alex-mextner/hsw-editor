/** Seat proposals on the real daemon: `GET /api/walls/:id/items/:itemId/seat` and `GET /api/walls/:id/seat`. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LeafOp, WallResponse } from '@hsw-editor/core';
import { startServer, type RunningServer } from '../server.ts';
import type { SeatProposalView, WallPhysicsView, WallSeatView } from './service.ts';

const HOLDER = 'screwdriver-rail-slots6-holediameter5';
const DRIVER_PARAMS = { shaftDiameter: 4, tipWidth: 4 };
const HOLDER_POSE = { x: 300, y: 300, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
/** A tool hung at a compatibility-style pose: hovering above its rail, not lowered into it. */
const HOVER = { x: 300, y: 480, z: 15, rotX: 0, rotY: 0, rotZ: 0 };
const FALLING = ['levitating', 'falls', 'penetrates'];

let root: string;
let running: RunningServer;
let savedBankDir: string | undefined;

async function post(path: string, body: object): Promise<Response> {
  return fetch(`${running.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${running.url}${path}`);
  return { status: response.status, body: (await response.json()) as T };
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

function holder(id: string, x: number, rotZ = 0): object {
  return {
    type: 'addItem',
    item: {
      id,
      kind: 'holder',
      bankId: HOLDER,
      pose: { ...HOLDER_POSE, x, rotZ },
      source: { type: 'agent' },
    },
  };
}

function driver(id: string, extra: object): object {
  return {
    type: 'addItem',
    item: {
      id,
      kind: 'tool',
      modelRefId: 'm-driver',
      toolClass: 'screwdriver',
      params: DRIVER_PARAMS,
      pose: HOVER,
      source: { type: 'agent' },
      ...extra,
    },
  };
}

async function newWall(id: string, ops: object[]): Promise<number> {
  expect((await post('/api/walls', { id, name: id })).status).toBe(201);
  const applied = await post(`/api/walls/${id}/ops`, { ops: [driverModel, ...ops] });
  expect(applied.status).toBe(200);
  const body = (await applied.json()) as { rev: number };
  return body.rev;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-seat-'));
  savedBankDir = process.env['HSW_BANK_DIR'];
  delete process.env['HSW_BANK_DIR'];
  running = await startServer({
    port: 0,
    host: '127.0.0.1',
    home: join(root, 'home'),
    webDist: join(root, 'dist'),
    allowedOrigins: [],
    heartbeatMs: 1000,
  });
}, 120_000);

afterAll(async () => {
  await running.stop();
  if (savedBankDir !== undefined) process.env['HSW_BANK_DIR'] = savedBankDir;
  rmSync(root, { recursive: true, force: true });
});

describe('seat proposals over REST', () => {
  test('a hovering tool is proposed a lower pose in its own slot, the wall is not written, and applying it clears the physics flags', async () => {
    const rev = await newWall('one', [
      holder('h-1', HOLDER_POSE.x),
      driver('t-1', { parentId: 'h-1', slot: 2 }),
    ]);
    const before = await get<WallPhysicsView>('/api/walls/one/physics');
    expect(before.body.tools[0]?.problems.some((problem) => FALLING.includes(problem.code))).toBe(
      true,
    );

    const { status, body } = await get<SeatProposalView>('/api/walls/one/items/t-1/seat');
    expect(status).toBe(200);
    expect(body).toMatchObject({ wallId: 'one', rev, toolId: 't-1', reason: null });
    const seat = body.seat;
    if (seat === null) throw new Error('the screwdriver has a seat in the rail');
    expect(seat).toMatchObject({ holderId: 'h-1', slot: 2, changed: true });
    expect(seat.from).toEqual(HOVER);
    // tip down in the rail instead of hovering tip up: another pose
    expect(seat.pose).not.toEqual(HOVER);
    expect(seat.status).not.toBe('unstable');

    // reading proposes only: the rev did not move
    const unchanged = await get<WallResponse>('/api/walls/one');
    expect(unchanged.body.wall.rev).toBe(rev);

    const applied = await post('/api/walls/one/ops', {
      baseRev: rev,
      ops: [
        {
          type: 'rotateItem',
          id: 't-1',
          rotX: seat.pose.rotX,
          rotY: seat.pose.rotY,
          rotZ: seat.pose.rotZ,
        },
        { type: 'moveItem', id: 't-1', to: { x: seat.pose.x, y: seat.pose.y, z: seat.pose.z } },
      ] satisfies LeafOp[],
    });
    expect(applied.status).toBe(200);
    const after = await get<WallPhysicsView>('/api/walls/one/physics');
    expect(after.body.tools[0]?.problems.filter((p) => FALLING.includes(p.code))).toEqual([]);
    // what is left is advice (a leaning tool, two hands to take it off), not an error
    expect(after.body.tools[0]?.problems.filter((p) => p.severity === 'error')).toEqual([]);

    // seated already: asking again proposes no move
    const again = await get<SeatProposalView>('/api/walls/one/items/t-1/seat');
    expect(again.body.seat?.changed).toBe(false);
  }, 120_000);

  test('says why a tool has no seat instead of inventing one', async () => {
    await newWall('why', [
      holder('h-1', HOLDER_POSE.x),
      holder('h-turned', 800, 90),
      driver('t-free', {}),
      driver('t-turned', { parentId: 'h-turned', slot: 0 }),
      driver('t-orphan', { parentId: 'gone', slot: 0 }),
      driver('t-slotless', { parentId: 'h-1' }),
    ]);
    const reason = async (id: string) =>
      (await get<SeatProposalView>(`/api/walls/why/items/${id}/seat`)).body.reason?.code;
    expect(await reason('t-free')).toBe('no_holder');
    expect(await reason('t-turned')).toBe('holder_not_upright');
    expect(await reason('t-orphan')).toBe('holder_missing');
    expect(await reason('t-slotless')).toBe('no_slot');
  }, 120_000);

  test('client errors: unknown item, a holder, a bad slot, a write verb', async () => {
    await newWall('errs', [holder('h-1', HOLDER_POSE.x)]);
    expect((await get<object>('/api/walls/errs/items/ghost/seat')).status).toBe(404);
    expect((await get<object>('/api/walls/errs/items/h-1/seat')).status).toBe(409);
    expect((await get<object>('/api/walls/nowall/seat')).status).toBe(404);
    expect((await post('/api/walls/errs/seat', {})).status).toBe(405);
  });
});

describe('whole-wall seat proposal', () => {
  test('seats several tools of one holder in distinct slots in one batch; applying it clears every flag', async () => {
    const rev = await newWall('all', [
      holder('h-1', HOLDER_POSE.x),
      holder('h-2', 700),
      driver('t-a', { parentId: 'h-1', slot: 0 }),
      driver('t-b', { parentId: 'h-1', slot: 5, pose: { ...HOVER, x: HOVER.x + 100 } }),
      driver('t-c', { parentId: 'h-2', slot: 0, pose: { ...HOVER, x: 700 } }),
      driver('t-slotless', { parentId: 'h-2', pose: { ...HOVER, x: 730 } }),
      driver('t-loose', {}),
    ]);
    const { status, body } = await get<WallSeatView>('/api/walls/all/seat');
    expect(status).toBe(200);
    expect(body.rev).toBe(rev);
    expect(body.seats.map((seat) => seat.toolId).sort()).toEqual(['t-a', 't-b', 't-c']);
    expect(body.unslotted).toEqual(['t-slotless']);
    // a tool on no holder has nothing to seat: it is in none of the lists
    expect(body.kept).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('t-loose');
    expect(body.ops).toHaveLength(6);

    const applied = await post('/api/walls/all/ops', {
      baseRev: rev,
      ops: [{ type: 'batch', label: 'seat all', ops: body.ops }],
    });
    expect(applied.status).toBe(200);
    const after = await get<WallPhysicsView>('/api/walls/all/physics');
    const seatedIds = new Set(['t-a', 't-b', 't-c']);
    for (const tool of after.body.tools.filter((t) => seatedIds.has(t.toolId))) {
      expect(tool.problems.filter((p) => FALLING.includes(p.code))).toEqual([]);
    }
    // seated: a second pass has nothing to move
    const second = await get<WallSeatView>('/api/walls/all/seat');
    expect(second.body.ops).toEqual([]);
    expect([...second.body.unchanged].sort()).toEqual(['t-a', 't-b', 't-c']);
  }, 180_000);
});
