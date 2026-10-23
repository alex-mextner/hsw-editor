/**
 * Test doubles for the offline layer: a wall builder and a fake daemon that enforces `baseRev` and runs
 * the real core reducer, so replay tests exercise the actual op semantics.
 */
import {
  applyOp,
  createEmptyWall,
  OpError,
  type ApplyResponse,
  type ApplyResult,
  type Actor,
  type LeafOp,
  type Op,
  type Wall,
  type WallItem,
} from '@hsw-editor/core';
import { EVENT_SOURCE_CLOSED, type EventSourceLike } from './events.ts';
import { LiveRecord, newRecord } from './mirror.ts';
import { editToOp, flattenOps, type QueuedEdit, type WallRecord } from './record.ts';
import type { ReplayTransport, TransportResult } from './replay.ts';

export const ME: Actor = { kind: 'human', name: 'web-test' };
export const AGENT: Actor = { kind: 'agent', name: 'omp' };

export function holder(id: string, col: number, row: number): WallItem {
  return {
    id,
    kind: 'holder',
    bankId: 'holder-1',
    cell: { col, row },
    pose: { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

/** Wall `w1` with the given items, rev = number of items added. */
export function wallWith(...items: WallItem[]): Wall {
  let wall = createEmptyWall('w1', 'Test wall');
  for (const item of items) wall = applyOp(wall, { type: 'addItem', item }).wall;
  return wall;
}

export function edit(id: number, baseRev: number, ...ops: LeafOp[]): QueuedEdit {
  return { id, ops, baseRev, at: 1000 + id };
}

export function recordOf(wall: Wall, edits: readonly QueuedEdit[], actor: Actor = ME): WallRecord {
  return {
    ...newRecord(wall, actor, { canUndo: false, canRedo: false }, 0),
    edits,
    nextEditId: edits.length + 1,
  };
}

/** A `LiveRecord` that remembers every record it persisted. */
export function liveOf(record: WallRecord): { live: LiveRecord; saved: WallRecord[] } {
  const saved: WallRecord[] = [];
  const live = new LiveRecord(
    record,
    (next) => {
      saved.push(next);
      return Promise.resolve();
    },
    () => 0,
  );
  return { live, saved };
}

type DaemonMode = 'up' | 'down';

/** Daemon double: single wall, `baseRev` enforcement, history of accepted ops, scripted failures. */
export class FakeDaemon implements ReplayTransport {
  wall: Wall;
  mode: DaemonMode = 'up';
  /** Actor + op of every accepted request, in order. */
  readonly log: { actor: Actor; op: Op; rev: number }[] = [];
  /** Requests that reached the daemon (even those answered 409), for assertions. */
  requests = 0;
  /**
   * Request number (1-based, counted over the daemon's whole life) whose acknowledgement is lost: the daemon
   * applies the edit but the client sees a network failure.
   */
  loseAckOnRequest: number | null = null;
  /** Op types (of any leaf of an edit) the daemon refuses for good with `422 op_failed`. */
  rejectOpTypes = new Set<string>();
  /** Runs before each request; lets a test mutate the wall or the mode mid-replay. */
  beforeRequest: ((n: number) => void) | null = null;

  constructor(wall: Wall) {
    this.wall = wall;
  }

  /** Another actor edits the wall directly. */
  external(op: Op, actor: Actor = AGENT): void {
    const result = applyOp(this.wall, op);
    if (result.changed) {
      this.wall = result.wall;
      this.log.push({ actor, op, rev: result.wall.rev });
    }
  }

  applyOps(
    _wallId: string,
    queued: QueuedEdit,
    baseRev: number,
    actor: Actor,
  ): Promise<TransportResult<ApplyResponse>> {
    this.requests += 1;
    this.beforeRequest?.(this.requests);
    if (this.mode === 'down') return Promise.resolve({ kind: 'network' });
    if (baseRev !== this.wall.rev) return Promise.resolve({ kind: 'conflict', wall: this.wall });
    const op = editToOp(queued);
    if (flattenOps([op]).some((leaf) => this.rejectOpTypes.has(leaf.type))) {
      return Promise.resolve({ kind: 'rejected', code: 'op_failed', message: 'refused' });
    }
    let result: ApplyResult;
    try {
      result = applyOp(this.wall, op);
    } catch (error) {
      if (error instanceof OpError) {
        return Promise.resolve({ kind: 'rejected', code: 'op_failed', message: error.message });
      }
      throw error;
    }
    if (result.changed) {
      this.wall = result.wall;
      this.log.push({ actor, op, rev: result.wall.rev });
    }
    if (this.loseAckOnRequest === this.requests) return Promise.resolve({ kind: 'network' });
    return Promise.resolve({
      kind: 'ok',
      value: {
        rev: this.wall.rev,
        changed: result.changed,
        op,
        inverse: result.inverse,
        wall: this.wall,
        warnings: [],
        canUndo: true,
        canRedo: false,
      },
    });
  }
}

/** `EventSource` double: tests open it, push events and make it fail like the browser does. */
export class FakeSource implements EventSourceLike {
  readyState = 0;
  closedByClient = false;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closedByClient = true;
    this.readyState = EVENT_SOURCE_CLOSED;
  }
  emit(type: string, data?: string, lastEventId = ''): void {
    const event =
      data === undefined ? new Event(type) : new MessageEvent(type, { data, lastEventId });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  /** The browser gave up (non-200 answer): readyState CLOSED + error. */
  fail(): void {
    this.readyState = EVENT_SOURCE_CLOSED;
    this.emit('error');
  }
}
