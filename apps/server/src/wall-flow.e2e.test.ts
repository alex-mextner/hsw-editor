/**
 * Wall-from-scratch flow through the real HTTP API (#5): create a wall exactly as the new-wall dialog does, add and
 * move elements as the bank panel and the viewport do, then restart the daemon on the same data dir and check that the
 * wall, its history and undo are all still there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApplyResponse, WallResponse, WallSummary } from '@hsw-editor/core';
import { startServer, type RunningServer } from './server.ts';

/** `Response.json()` is untyped; the call site names the shape it expects. */
interface TypedResponse extends Omit<Response, 'json'> {
  json<T>(): Promise<T>;
}

let root: string;
let running: RunningServer | null = null;

async function boot(): Promise<RunningServer> {
  return startServer(
    {
      port: 0,
      host: '127.0.0.1',
      home: join(root, 'home'),
      webDist: join(root, 'dist'),
      allowedOrigins: [],
      heartbeatMs: 60_000,
    },
    { modules: [] },
  );
}

async function call(path: string, init?: RequestInit): Promise<TypedResponse> {
  if (!running) throw new Error('daemon is not running');
  const response = await fetch(`${running.url}${path}`, init);
  // one deliberate cast: same object, narrower json() signature
  return response as TypedResponse;
}

function post(path: string, body: unknown): Promise<TypedResponse> {
  return call(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'hsw-flow-'));
  running = await boot();
});

afterAll(async () => {
  await running?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('wall-from-scratch flow (create, add elements, restart the daemon)', () => {
  let wallId = '';

  test('the new-wall dialog request (name + board from width, height and pitch) creates an empty wall', async () => {
    // 982 x 767 mm at the HSW pitch is the dialog's "Standard" size: 48 x 32 cells.
    const response = await post('/api/walls', {
      name: 'Garage',
      board: { cols: 48, rows: 32, colPitchMm: 20.4382, rowPitchMm: 23.6 },
    });
    expect(response.status).toBe(201);
    const created = await response.json<WallResponse>();
    wallId = created.wall.id;
    expect(created.wall).toMatchObject({
      name: 'Garage',
      rev: 0,
      board: { cols: 48, rows: 32, colPitchMm: 20.4382, rowPitchMm: 23.6 },
    });
    expect(created.wall.items).toHaveLength(0);
    const listed = await (await call('/api/walls')).json<{ walls: WallSummary[] }>();
    expect(listed.walls.map((entry) => entry.id)).toContain(wallId);
  });

  test('elements added from the bank and moved on the grid are ops with their own revs', async () => {
    const add = await post(`/api/walls/${wallId}/ops`, {
      ops: [
        {
          type: 'addItem',
          item: {
            id: 'h1',
            kind: 'holder',
            bankId: 'cable-hanger-hangerreach100-strapwidth20',
            cell: { col: 4, row: 3 },
          },
        },
        {
          type: 'addItem',
          item: {
            id: 'h2',
            kind: 'holder',
            bankId: 'cable-hanger-hangerreach70-strapwidth20',
            cell: { col: 12, row: 7 },
          },
        },
      ],
      actor: { kind: 'human' },
      label: 'add from bank',
    });
    expect(add.status).toBe(200);
    expect((await add.json<ApplyResponse>()).rev).toBe(1);

    const move = await post(`/api/walls/${wallId}/ops`, {
      ops: [{ type: 'moveItem', id: 'h2', to: { cell: { col: 20, row: 9 } } }],
      actor: { kind: 'human' },
    });
    expect((await move.json<ApplyResponse>()).rev).toBe(2);
  });

  test('after a daemon restart the wall, its items and the history are read back from disk', async () => {
    await running?.stop();
    running = null;
    running = await boot();

    const reopened = await (await call(`/api/walls/${wallId}`)).json<WallResponse>();
    expect(reopened.wall.rev).toBe(2);
    expect(reopened.wall.name).toBe('Garage');
    expect(reopened.wall.items.map((item) => [item.id, item.cell])).toEqual([
      ['h1', { col: 4, row: 3 }],
      ['h2', { col: 20, row: 9 }],
    ]);
    expect(reopened.canUndo).toBe(true);

    const history = await (
      await call(`/api/walls/${wallId}/history`)
    ).json<{
      entries: { rev: number; kind: string }[];
    }>();
    // rev 0 is the wall's own `create` entry
    expect(history.entries.map((entry) => [entry.rev, entry.kind])).toEqual([
      [0, 'create'],
      [1, 'op'],
      [2, 'op'],
    ]);
  });

  test('undo still works after the restart: the move is reverted from the stored inverse', async () => {
    const undone = await post(`/api/walls/${wallId}/undo`, {});
    expect(undone.status).toBe(200);
    const wall = (await undone.json<ApplyResponse>()).wall;
    expect(wall.items.find((item) => item.id === 'h2')?.cell).toEqual({ col: 12, row: 7 });
  });
});
