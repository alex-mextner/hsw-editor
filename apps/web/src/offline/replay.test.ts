import { describe, expect, test } from 'bun:test';
import { enqueueEdit } from './mirror.ts';
import { replayQueue, type ReplayOutcome } from './replay.ts';
import { AGENT, edit, FakeDaemon, holder, liveOf, ME, recordOf, wallWith } from './testing.ts';
import type { QueuedEdit } from './record.ts';

const move = (id: string, col: number, row: number) =>
  ({ type: 'moveItem', id, to: { cell: { col, row } } }) as const;

function setup(edits: (baseRev: number) => QueuedEdit[] = () => []) {
  const base = wallWith(holder('a', 1, 1), holder('b', 3, 3));
  const daemon = new FakeDaemon(base);
  const { live, saved } = liveOf(recordOf(base, edits(base.rev)));
  return { base, daemon, live, saved };
}

function cell(daemon: FakeDaemon, id: string) {
  return daemon.wall.items.find((item) => item.id === id)?.cell;
}

function expectKind<K extends ReplayOutcome['kind']>(
  outcome: ReplayOutcome,
  kind: K,
): Extract<ReplayOutcome, { kind: K }> {
  expect(outcome.kind).toBe(kind);
  return outcome as Extract<ReplayOutcome, { kind: K }>;
}

describe('replayQueue', () => {
  test('an empty queue is synced without a request', async () => {
    const { daemon, live } = setup();
    const outcome = await replayQueue({ store: live, transport: daemon });
    expect(expectKind(outcome, 'synced').applied).toBe(0);
    expect(daemon.requests).toBe(0);
  });

  test('edits replay in order, each with the previous acknowledgement as baseRev', async () => {
    const { base, daemon, live, saved } = setup((rev) => [
      edit(1, rev, move('a', 2, 2)),
      edit(2, rev, move('a', 4, 4)),
      edit(3, rev, move('b', 6, 6)),
    ]);
    const outcome = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(outcome.applied).toBe(3);
    expect(cell(daemon, 'a')).toEqual({ col: 4, row: 4 });
    expect(cell(daemon, 'b')).toEqual({ col: 6, row: 6 });
    expect(daemon.log.map((entry) => entry.actor)).toEqual([ME, ME, ME]);
    expect(daemon.log.map((entry) => entry.rev)).toEqual([
      base.rev + 1,
      base.rev + 2,
      base.rev + 3,
    ]);
    // The stored queue shrinks edit by edit.
    expect(saved.map((r) => r.edits.length)).toEqual([2, 1, 0]);
    expect(outcome.record.wall.rev).toBe(base.rev + 3);
  });

  test('disjoint remote edits made while offline are rebased without asking', async () => {
    const { daemon, live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    daemon.external(move('b', 7, 7));
    const outcome = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(outcome.applied).toBe(1);
    expect(cell(daemon, 'a')).toEqual({ col: 2, row: 2 });
    expect(cell(daemon, 'b')).toEqual({ col: 7, row: 7 });
    // Two history entries: theirs by the agent, then mine on top of it.
    expect(daemon.log.map((entry) => entry.actor)).toEqual([AGENT, ME]);
  });

  test('overlapping edits wait for the user and change nothing meanwhile', async () => {
    const { daemon, live, saved } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    daemon.external(move('a', 9, 9));
    const outcome = expectKind(
      await replayQueue({ store: live, transport: daemon }),
      'needs-decision',
    );
    expect(outcome.plan.conflicts).toHaveLength(1);
    expect(outcome.server.rev).toBe(daemon.wall.rev);
    expect(cell(daemon, 'a')).toEqual({ col: 9, row: 9 });
    expect(saved).toEqual([]);
  });

  test('a daemon older than the device (restored backup) is a decision even without conflicts', async () => {
    const { base, live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    const rolledBack = new FakeDaemon({ ...base, rev: base.rev - 1 });
    // The device believes the daemon is at base.rev, so it sends baseRev = base.rev: the daemon answers 409.
    const outcome = expectKind(
      await replayQueue({ store: live, transport: rolledBack }),
      'needs-decision',
    );
    expect(outcome.plan.diverged).toBe(true);
    expect(outcome.plan.conflicts).toEqual([]);
  });

  test.each([
    ['rebase', { col: 2, row: 2 }],
    ['keepMine', { col: 2, row: 2 }],
    ['keepTheirs', { col: 9, row: 9 }],
  ] as const)('the chosen strategy %s decides the overlap', async (strategy, expected) => {
    const { daemon, live } = setup((rev) => [
      edit(1, rev, move('a', 2, 2)),
      edit(2, rev, move('b', 6, 6)),
    ]);
    daemon.external(move('a', 9, 9));
    const outcome = expectKind(
      await replayQueue({
        store: live,
        transport: daemon,
        decision: { strategy, serverRev: daemon.wall.rev },
      }),
      'synced',
    );
    expect(cell(daemon, 'a')).toEqual(expected);
    expect(cell(daemon, 'b')).toEqual({ col: 6, row: 6 });
    expect(outcome.record.edits).toEqual([]);
  });

  test('keepMine restores an item the other side removed and reports it', async () => {
    const { daemon, live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    daemon.external({ type: 'removeItem', id: 'a' });
    const outcome = expectKind(
      await replayQueue({
        store: live,
        transport: daemon,
        decision: { strategy: 'keepMine', serverRev: daemon.wall.rev },
      }),
      'synced',
    );
    expect(outcome.restored).toEqual(['item:a']);
    expect(cell(daemon, 'a')).toEqual({ col: 2, row: 2 });
  });

  test('rebase reports the edit it had to drop', async () => {
    const { daemon, live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    daemon.external({ type: 'removeItem', id: 'a' });
    const outcome = expectKind(
      await replayQueue({
        store: live,
        transport: daemon,
        decision: { strategy: 'rebase', serverRev: daemon.wall.rev },
      }),
      'synced',
    );
    expect(outcome.dropped).toMatchObject([{ reason: 'inapplicable', code: 'item_not_found' }]);
    expect(daemon.wall.items.some((item) => item.id === 'a')).toBe(false);
  });

  test('losing the connection mid-replay keeps the rest queued and resumes later', async () => {
    const { daemon, live, saved } = setup((rev) => [
      edit(1, rev, move('a', 2, 2)),
      edit(2, rev, move('a', 4, 4)),
      edit(3, rev, move('b', 6, 6)),
    ]);
    daemon.beforeRequest = (n) => {
      if (n === 2) daemon.mode = 'down';
    };
    const first = expectKind(await replayQueue({ store: live, transport: daemon }), 'offline');
    expect(first.applied).toBe(1);
    expect(first.record.edits.map((e) => e.id)).toEqual([2, 3]);
    expect(saved.at(-1)?.edits.map((e) => e.id)).toEqual([2, 3]);

    daemon.mode = 'up';
    daemon.beforeRequest = null;
    const second = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(second.applied).toBe(2);
    expect(cell(daemon, 'a')).toEqual({ col: 4, row: 4 });
    expect(daemon.log).toHaveLength(3);
  });

  test('an edit the user makes while the replay runs is kept, not overwritten by the replay', async () => {
    const { base, daemon, live } = setup((rev) => [
      edit(1, rev, move('a', 2, 2)),
      edit(2, rev, move('b', 6, 6)),
    ]);
    daemon.beforeRequest = (n) => {
      if (n === 1) {
        void live.update((record) =>
          enqueueEdit(record, [{ type: 'rotateItem', id: 'a', rotZ: 60 }], undefined, 5),
        );
      }
    };
    const outcome = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    // The late edit got a fresh id (3), was replayed after the others, and nothing was lost or reused.
    expect(outcome.applied).toBe(3);
    expect(daemon.wall.items.find((i) => i.id === 'a')?.pose.rotZ).toBe(60);
    expect(daemon.wall.rev).toBe(base.rev + 3);
    expect(live.read().nextEditId).toBe(4);
  });

  test('a decision made for an older daemon state is not applied to a newer one: the user is asked again', async () => {
    const { daemon, live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    daemon.external(move('a', 9, 9));
    const first = expectKind(
      await replayQueue({ store: live, transport: daemon }),
      'needs-decision',
    );
    daemon.external(move('b', 7, 7)); // the daemon moves on while the dialog is open
    const again = expectKind(
      await replayQueue({
        store: live,
        transport: daemon,
        decision: { strategy: 'keepMine', serverRev: first.server.rev },
      }),
      'needs-decision',
    );
    expect(again.server.rev).toBe(daemon.wall.rev);
  });

  test('a second replay started while one runs joins it instead of racing it', async () => {
    const { daemon, live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    const one = replayQueue({ store: live, transport: daemon });
    const two = replayQueue({ store: live, transport: daemon });
    expect(two).toBe(one);
    await one;
    expect(daemon.requests).toBe(1);
  });

  test('a lost acknowledgement of a batch that creates and changes an item is not a conflict', async () => {
    const { daemon, live } = setup((rev) => [
      edit(
        1,
        rev,
        { type: 'addItem', item: holder('n', 5, 5) },
        { type: 'rotateItem', id: 'n', rotZ: 60 },
      ),
    ]);
    daemon.loseAckOnRequest = 1;
    expectKind(await replayQueue({ store: live, transport: daemon }), 'offline');
    daemon.loseAckOnRequest = null;
    const outcome = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(outcome.applied).toBe(0);
    expect(daemon.wall.items.filter((i) => i.id === 'n')).toHaveLength(1);
  });

  test('a lost acknowledgement does not apply the edit twice', async () => {
    const { daemon, live } = setup((rev) => [
      edit(1, rev, { type: 'addItem', item: holder('n', 5, 5) }),
      edit(2, rev, move('b', 6, 6)),
    ]);
    daemon.loseAckOnRequest = 1;
    const first = expectKind(await replayQueue({ store: live, transport: daemon }), 'offline');
    // The daemon applied edit 1 but the device never learned: the record still holds both edits.
    expect(first.record.edits.map((e) => e.id)).toEqual([1, 2]);
    expect(daemon.wall.items.some((item) => item.id === 'n')).toBe(true);

    daemon.loseAckOnRequest = null;
    const second = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(daemon.wall.items.filter((item) => item.id === 'n')).toHaveLength(1);
    expect(cell(daemon, 'b')).toEqual({ col: 6, row: 6 });
    // Edit 1 was recognised as already applied (redundant): only edit 2 counts as newly applied.
    expect(second.applied).toBe(1);
    expect(second.dropped).toEqual([]);
  });

  test('a lost acknowledgement is not "theirs": my follow-up edit on the same item is no conflict', async () => {
    const { daemon, live } = setup((rev) => [
      edit(1, rev, { type: 'addItem', item: holder('n', 5, 5) }),
      edit(2, rev, { type: 'rotateItem', id: 'n', rotZ: 60 }),
    ]);
    daemon.loseAckOnRequest = 1;
    expectKind(await replayQueue({ store: live, transport: daemon }), 'offline');
    daemon.loseAckOnRequest = null;
    // No strategy given: a false conflict would stop here with `needs-decision`.
    const outcome = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(outcome.applied).toBe(1);
    expect(daemon.wall.items.find((i) => i.id === 'n')?.pose.rotZ).toBe(60);
  });

  test('the same holds for two moves of one item after a lost acknowledgement', async () => {
    const { daemon, live } = setup((rev) => [
      edit(1, rev, move('a', 2, 2)),
      edit(2, rev, move('a', 4, 4)),
    ]);
    daemon.loseAckOnRequest = 1;
    expectKind(await replayQueue({ store: live, transport: daemon }), 'offline');
    daemon.loseAckOnRequest = null;
    expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(cell(daemon, 'a')).toEqual({ col: 4, row: 4 });
  });

  test('an edit the daemon refuses for good is dropped and reported, the rest goes on', async () => {
    const { daemon, live } = setup((rev) => [
      edit(1, rev, { type: 'rotateItem', id: 'a', rotZ: 60 }),
      edit(2, rev, move('b', 6, 6)),
    ]);
    daemon.rejectOpTypes.add('rotateItem');
    const outcome = expectKind(await replayQueue({ store: live, transport: daemon }), 'synced');
    expect(outcome.dropped).toMatchObject([{ reason: 'rejected', code: 'op_failed' }]);
    expect(outcome.applied).toBe(1);
  });

  test('a wall that keeps changing gives up instead of looping', async () => {
    const { daemon, live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    let col = 10;
    daemon.beforeRequest = () => {
      col += 1;
      daemon.external(move('b', col, col));
    };
    const outcome = expectKind(await replayQueue({ store: live, transport: daemon }), 'failed');
    expect(outcome.message).toContain('keeps changing');
    expect(outcome.record.edits).toHaveLength(1);
  });

  test('a deleted wall is reported', async () => {
    const { live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    const gone = { applyOps: () => Promise.resolve({ kind: 'gone' } as const) };
    expect((await replayQueue({ store: live, transport: gone })).kind).toBe('gone');
  });

  test('a server error stops the replay and keeps the queue', async () => {
    const { live } = setup((rev) => [edit(1, rev, move('a', 2, 2))]);
    const broken = {
      applyOps: () => Promise.resolve({ kind: 'error', message: 'HTTP 500' } as const),
    };
    const outcome = expectKind(await replayQueue({ store: live, transport: broken }), 'failed');
    expect(outcome.record.edits).toHaveLength(1);
  });
});
