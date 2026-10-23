import { describe, expect, test } from 'bun:test';
import type { Pose } from '@hsw-editor/core';
import type { RankedSeat, RemovalReport } from '@hsw-editor/physics';
import { seatOps } from './seat.ts';
import {
  type HolderRating,
  rankCandidates,
  ratingOfSeat,
  settleAfterDrop,
  steadyOrder,
  SWITCH_MARGIN,
} from './suggest.ts';
import { fakeEditor, fakeSeat, holderItem, toolItem, wallOf } from './testWall.testkit.ts';

const SEATED_H1: Pose = { x: 85, y: 31, z: 15, rotX: 0, rotY: 0, rotZ: 180 };
const SEATED_H2: Pose = { x: 245, y: 31, z: 15, rotX: 0, rotY: 0, rotZ: 180 };
/** The compatibility pose the tool was hung with on h1. */
const HUNG: Partial<Pose> = { x: 70, y: 90, z: 40, rotZ: 180 };

function wallWith(holders: readonly [string, number][]) {
  const driver = toolItem('drv', { parentId: 'h1', slot: 1, pose: HUNG });
  return wallOf(
    holders.map(([id, x]) => holderItem(id, 'rack', { x, y: 50 })),
    [driver],
  );
}

/** Answers every request like `rankHolders`: the seats of the candidate holders it names, best first. */
function answer(seats: Record<string, RankedSeat>) {
  return (request: { candidates: readonly { holder: { id: string } }[] }): RankedSeat[] =>
    request.candidates
      .flatMap((c) => {
        const seat = seats[c.holder.id];
        return seat === undefined ? [] : [seat];
      })
      .sort((a, b) => b.combined - a.combined);
}

const AT = { x: 180, y: 70 };

describe('settleAfterDrop', () => {
  test('a clearly more stable holder in reach takes the tool: one hang batch with the seat pose on its nearest free slot', async () => {
    const editor = fakeEditor(
      wallWith([
        ['h1', 100],
        ['h2', 260],
      ]),
      answer({
        h1: fakeSeat('h1', SEATED_H1, { combined: 0.4 }),
        h2: fakeSeat('h2', SEATED_H2, { combined: 0.9 }),
      }),
    );
    expect(await settleAfterDrop('drv', AT, editor.deps)).toBe('rehung');
    expect(editor.requests).toHaveLength(1);
    expect(editor.requests[0]?.candidates.map((c) => c.holder.id).sort()).toEqual(['h1', 'h2']);
    expect(editor.requests[0]?.removal).toBe(true);
    expect(editor.submitted).toEqual([
      {
        label: 'hang',
        ops: [
          {
            type: 'batch',
            label: 'hang',
            ops: [
              { type: 'attachItem', id: 'drv', parentId: 'h2', slot: 0 },
              ...seatOps('drv', SEATED_H2).ops,
            ],
          },
        ],
      },
    ]);
  });

  test('a tiny advantage does not move the tool: it is seated where it hangs', async () => {
    const editor = fakeEditor(
      wallWith([
        ['h1', 100],
        ['h2', 260],
      ]),
      answer({
        h1: fakeSeat('h1', SEATED_H1, { combined: 0.8 }),
        h2: fakeSeat('h2', SEATED_H2, { combined: 0.8 + SWITCH_MARGIN / 2 }),
      }),
    );
    expect(await settleAfterDrop('drv', AT, editor.deps)).toBe('seated');
    expect(editor.submitted).toEqual([{ ops: [seatOps('drv', SEATED_H1)], label: 'seat' }]);
  });

  test('the holder it hangs on being best, it is just seated', async () => {
    const editor = fakeEditor(
      wallWith([
        ['h1', 100],
        ['h2', 260],
      ]),
      answer({
        h1: fakeSeat('h1', SEATED_H1, { combined: 0.95 }),
        h2: fakeSeat('h2', SEATED_H2, { combined: 0.2 }),
      }),
    );
    expect(await settleAfterDrop('drv', AT, editor.deps)).toBe('seated');
    expect(editor.submitted[0]?.label).toBe('seat');
  });

  test('a holder where no seat exists loses to one where there is', async () => {
    const editor = fakeEditor(
      wallWith([
        ['h1', 100],
        ['h2', 260],
      ]),
      answer({ h2: fakeSeat('h2', SEATED_H2, { combined: 0.3 }) }),
    );
    expect(await settleAfterDrop('drv', AT, editor.deps)).toBe('rehung');
  });

  test('holders beyond the snap radius of the drop point are not candidates', async () => {
    const editor = fakeEditor(
      wallWith([
        ['h1', 100],
        ['far', 900],
      ]),
      answer({
        h1: fakeSeat('h1', SEATED_H1, { combined: 0.5 }),
        far: fakeSeat('far', SEATED_H2, { combined: 1 }),
      }),
    );
    expect(await settleAfterDrop('drv', { x: 100, y: 70 }, editor.deps)).toBe('seated');
    expect(editor.requests.flatMap((r) => r.candidates.map((c) => c.holder.id))).toEqual(['h1']);
  });

  test('a holder that does not take the tool is not a candidate', async () => {
    const wall = wallWith([
      ['h1', 100],
      ['h2', 260],
    ]);
    const pliers = toolItem('pl', { toolClass: 'pliers' });
    wall.items.push(pliers.item);
    wall.models.push(pliers.model);
    const editor = fakeEditor(
      wall,
      answer({ h1: fakeSeat('h1', SEATED_H1), h2: fakeSeat('h2', SEATED_H2) }),
    );
    expect(await settleAfterDrop('pl', AT, editor.deps)).toBe('skipped');
  });

  test('stale after the worker answers: nothing is submitted', async () => {
    const editor = fakeEditor(
      wallWith([
        ['h1', 100],
        ['h2', 260],
      ]),
      () => {
        editor.wall = wallWith([
          ['h1', 100],
          ['h2', 260],
        ]);
        const moved = editor.wall.items.find((i) => i.id === 'drv');
        if (moved !== undefined) moved.pose = { ...moved.pose, x: 1 };
        return [
          fakeSeat('h1', SEATED_H1, { combined: 0.1 }),
          fakeSeat('h2', SEATED_H2, { combined: 0.9 }),
        ];
      },
    );
    expect(await settleAfterDrop('drv', AT, editor.deps)).toBe('stale');
    expect(editor.submitted).toEqual([]);
  });

  test('switched off: no work', async () => {
    const editor = fakeEditor(
      wallWith([
        ['h1', 100],
        ['h2', 260],
      ]),
      () => [],
    );
    editor.enabled = false;
    expect(await settleAfterDrop('drv', AT, editor.deps)).toBe('off');
    expect(editor.requests).toEqual([]);
  });
});

describe('ratingOfSeat', () => {
  test('stability from the hang score, convenience from the removal, reasons from both', () => {
    const removal: RemovalReport = {
      verdict: 'needs_tilt',
      convenience: 0.4,
      clearanceMm: 3,
      neighbourGapMm: 8,
      path: 'tilt x +15 deg, lift',
      liftMm: 10,
      pullMm: 0,
      blockedBy: [],
      reasons: [],
    };
    const rating = ratingOfSeat({ ...fakeSeat('h', SEATED_H1, { score: 0.5 }), removal });
    expect(rating).toMatchObject({ stability: 0.5, convenience: 0.4, status: 'marginal' });
    expect(rating.reasons.map((r) => r.code)).toEqual(['removal_needs_tilt']);
  });

  test('without a removal probe the convenience is unknown', () => {
    expect(ratingOfSeat(fakeSeat('h', SEATED_H1)).convenience).toBeNull();
  });
});

const rating = (stability: number, convenience: number | null = null): HolderRating => ({
  stability,
  convenience,
  status: stability > 0.7 ? 'stable' : 'unstable',
  reasons: [],
});

const card = (id: string, score: number) => ({ element: { id }, score });

describe('rankCandidates', () => {
  test('physics outweighs a better fit; an unrated holder keeps its fit score; ties keep the incoming order', () => {
    const cards = [
      card('snug-but-unstable', 0.95),
      card('plain-but-stable', 0.7),
      card('unknown', 0.8),
    ];
    const ratings = new Map([
      ['snug-but-unstable', rating(0.1)],
      ['plain-but-stable', rating(1, 1)],
    ]);
    expect(rankCandidates(cards, ratings).map((c) => c.element.id)).toEqual([
      'plain-but-stable',
      'unknown',
      'snug-but-unstable',
    ]);
    const tied = [card('a', 0.8), card('b', 0.8)];
    expect(rankCandidates(tied, new Map()).map((c) => c.element.id)).toEqual(['a', 'b']);
  });
});

describe('steadyOrder', () => {
  const ranked = ['a', 'b', 'c', 'd'].map((id) => ({ element: { id } }));
  const ids = (list: readonly { element: { id: string } }[]): string[] =>
    list.map((c) => c.element.id);

  test('no rows shown yet: the ranked order', () => {
    expect(ids(steadyOrder(ranked, []))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('rows move by at most one place: the order on screen stays', () => {
    expect(ids(steadyOrder(ranked, ['b', 'a', 'c', 'd']))).toEqual(['b', 'a', 'c', 'd']);
  });

  test('a row that would move two places or more makes the list re-sort', () => {
    expect(ids(steadyOrder(ranked, ['c', 'a', 'b', 'd']))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('a different set of rows starts again from the ranked order', () => {
    expect(ids(steadyOrder(ranked, ['a', 'b', 'x']))).toEqual(['a', 'b', 'c', 'd']);
  });
});
