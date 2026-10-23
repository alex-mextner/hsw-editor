import { describe, expect, test } from 'bun:test';
import {
  applyOp,
  createEmptyWall,
  newId,
  OpError,
  type Actor,
  type Op,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { ApiError, NetworkError } from '@/api/http.ts';
import type { ChangeEntry, OpResponse, WallResponse } from '@/api/schemas.ts';
import { WallSync, type SyncApi } from './sync.ts';

const ME: Actor = { kind: 'human', name: 'web-test' };

function holder(id: string, col = 1, row = 1): WallItem {
  return {
    id,
    kind: 'holder',
    bankId: 'hook',
    cell: { col, row },
    pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

/** A tiny in-memory server with the documented semantics: baseRev check, reducer, 422 on refusal. */
class FakeServer implements SyncApi {
  wall: Wall = createEmptyWall('w', 'Wall');
  calls: { baseRev: number; ops: readonly Op[] }[] = [];
  failNext: Error | null = null;
  readonly events: ChangeEntry[] = [];

  private respond(result: ReturnType<typeof applyOp>, op: Op): OpResponse {
    this.wall = result.wall;
    return {
      rev: result.wall.rev,
      changed: result.changed,
      op,
      inverse: result.inverse,
      wall: result.wall,
      warnings: [],
      canUndo: true,
      canRedo: false,
    };
  }

  /** An edit by someone else (agent/CLI); emits the SSE entry a subscribed client would see. */
  external(op: Op, actor: Actor = { kind: 'agent', name: 'omp' }): ChangeEntry {
    const result = applyOp(this.wall, op);
    this.wall = result.wall;
    const entry: ChangeEntry = {
      rev: result.wall.rev,
      ts: '2026-10-22T00:00:00Z',
      actor,
      kind: 'op',
      op,
      inverse: result.inverse,
    };
    this.events.push(entry);
    return entry;
  }

  getWall(): Promise<WallResponse> {
    return Promise.resolve({
      wall: this.wall,
      canUndo: this.wall.rev > 0,
      canRedo: false,
      warnings: [],
    });
  }

  applyOps(_id: string, ops: readonly Op[], baseRev: number): Promise<OpResponse> {
    this.calls.push({ baseRev, ops });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    if (baseRev !== this.wall.rev) {
      return Promise.reject(
        new ApiError(409, 'rev_conflict', 'stale', {
          error: { code: 'rev_conflict', message: 'stale' },
          wall: this.wall,
          currentRev: this.wall.rev,
        }),
      );
    }
    const op: Op = ops.length === 1 && ops[0] ? ops[0] : { type: 'batch', ops: ops as never };
    try {
      return Promise.resolve(this.respond(applyOp(this.wall, op), op));
    } catch (error) {
      if (error instanceof OpError) {
        return Promise.reject(new ApiError(422, 'op_failed', error.message, null));
      }
      throw error;
    }
  }

  undo(): Promise<OpResponse> {
    return Promise.reject(new ApiError(409, 'nothing_to_undo', 'nothing', null));
  }

  redo(): Promise<OpResponse> {
    return Promise.reject(new ApiError(409, 'nothing_to_redo', 'nothing', null));
  }
}

async function ready(server: FakeServer): Promise<WallSync> {
  const sync = new WallSync('w', server, ME);
  await sync.load();
  return sync;
}

describe('WallSync optimistic edits', () => {
  test('an edit shows immediately and is confirmed with the server revision', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    const result = sync.submit([{ type: 'addItem', item: holder('a') }]);
    expect(result.ok).toBe(true);
    // Before the server answers the view already has the item.
    expect(sync.getSnapshot().wall?.items.map((i) => i.id)).toEqual(['a']);
    expect(sync.getSnapshot().pending).toBe(1);
    await sync.idle();
    expect(sync.getSnapshot().pending).toBe(0);
    expect(sync.getSnapshot().confirmedRev).toBe(1);
    expect(server.wall.items).toHaveLength(1);
  });

  test('queued edits are sent in order, each with the revision the previous one produced', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    sync.submit([{ type: 'addItem', item: holder('a') }]);
    sync.submit([{ type: 'addItem', item: holder('b', 3, 3) }]);
    sync.submit([{ type: 'moveItem', id: 'a', to: { cell: { col: 5, row: 5 } } }]);
    await sync.idle();
    expect(server.calls.map((call) => call.baseRev)).toEqual([0, 1, 2]);
    expect(sync.getSnapshot().confirmedRev).toBe(3);
    expect(server.wall.items.find((i) => i.id === 'a')?.cell).toEqual({ col: 5, row: 5 });
  });

  test('a refused edit rolls back to the server state and explains why', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    sync.submit([{ type: 'addItem', item: holder('a') }]);
    await sync.idle();
    // Another actor locks the item while the user's move is already queued locally.
    server.failNext = new ApiError(422, 'op_failed', 'item a is locked', null);
    sync.submit([{ type: 'moveItem', id: 'a', to: { cell: { col: 9, row: 9 } } }]);
    expect(sync.getSnapshot().wall?.items[0]?.cell).toEqual({ col: 9, row: 9 });
    await sync.idle();
    expect(sync.getSnapshot().wall?.items[0]?.cell).toEqual({ col: 1, row: 1 });
    expect(sync.getSnapshot().notice?.code).toBe('op_failed');
    expect(sync.getSnapshot().pending).toBe(0);
  });

  test('edits the reducer refuses locally are never queued', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    sync.submit([{ type: 'addItem', item: holder('a') }]);
    sync.submit([{ type: 'lock', id: 'a', locked: true }]);
    await sync.idle();
    const result = sync.submit([{ type: 'removeItem', id: 'a' }]);
    expect(result.ok).toBe(false);
    expect(server.calls).toHaveLength(2);
  });

  test('a stale baseRev is rebased onto the newer server wall and retried', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    // An agent edits on the server; the client has not heard about it yet.
    server.external({ type: 'addItem', item: holder('agent-1', 7, 7) });
    sync.submit([{ type: 'addItem', item: holder('mine', 2, 2) }]);
    await sync.idle();
    expect(server.calls.map((call) => call.baseRev)).toEqual([0, 1]);
    expect(server.wall.items.map((i) => i.id).sort()).toEqual(['agent-1', 'mine']);
    expect(
      sync
        .getSnapshot()
        .wall?.items.map((i) => i.id)
        .sort(),
    ).toEqual(['agent-1', 'mine']);
    expect(sync.getSnapshot().notice).toBeNull();
  });

  test('remote SSE edits appear live, are attributed, and pending edits rebase on top', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    // Block our own send so the edit stays pending while the remote event arrives.
    server.failNext = new NetworkError(new Error('down'));
    sync.submit([{ type: 'addItem', item: holder('mine', 2, 2) }]);
    await sync.idle();
    expect(sync.getSnapshot().status).toBe('offline');
    const entry = server.external({ type: 'addItem', item: holder('agent-1', 7, 7) });
    await sync.applyRemote(entry);
    const ids = sync.getSnapshot().wall?.items.map((i) => i.id);
    expect(ids).toEqual(['agent-1', 'mine']);
    expect(sync.getSnapshot().lastRemote?.actor).toEqual({ kind: 'agent', name: 'omp' });
    sync.dispose();
  });

  test('an echo of our own op (same rev) is ignored and does not duplicate anything', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    const item = holder(newId('i'), 4, 4);
    sync.submit([{ type: 'addItem', item }]);
    await sync.idle();
    const echo: ChangeEntry = {
      rev: 1,
      ts: '2026-10-22T00:00:00Z',
      actor: ME,
      kind: 'op',
      op: { type: 'addItem', item },
      inverse: { type: 'removeItem', id: item.id },
    };
    await sync.applyRemote(echo);
    expect(sync.getSnapshot().wall?.items).toHaveLength(1);
    expect(sync.getSnapshot().lastRemote).toBeNull();
  });

  test('a gap in revisions triggers a resync instead of guessing', async () => {
    const server = new FakeServer();
    const sync = await ready(server);
    server.external({ type: 'addItem', item: holder('x1', 1, 1) });
    const second = server.external({ type: 'addItem', item: holder('x2', 2, 2) });
    await sync.applyRemote(second); // rev 2 while the client is at rev 0
    expect(sync.getSnapshot().wall?.items.map((i) => i.id)).toEqual(['x1', 'x2']);
  });
});
