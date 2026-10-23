import { describe, expect, test } from 'bun:test';
import { applyOp, type Op, type Wall } from '@hsw-editor/core';
import { diffFootprint, opFootprint, overlappingEntities, subtractFootprint } from './footprint.ts';
import { planReplay, resolvePlan } from './reconcile.ts';
import { edit, holder, wallWith } from './testing.ts';

function apply(wall: Wall, op: Op): Wall {
  return applyOp(wall, op).wall;
}

const base = wallWith(holder('a', 1, 1), holder('b', 3, 3));

describe('footprint', () => {
  test('overlap needs the same field of the same entity', () => {
    const mine = opFootprint([{ type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } }]);
    const theirRotate = diffFootprint(base, apply(base, { type: 'rotateItem', id: 'a', rotZ: 60 }));
    const theirMove = diffFootprint(
      base,
      apply(base, { type: 'moveItem', id: 'a', to: { cell: { col: 5, row: 5 } } }),
    );
    expect(overlappingEntities(mine, theirRotate)).toEqual([]);
    expect(overlappingEntities(mine, theirMove)).toEqual(['item:a']);
  });

  test('removing an item overlaps every edit of it', () => {
    const removed = diffFootprint(base, apply(base, { type: 'removeItem', id: 'a' }));
    const mine = opFootprint([{ type: 'setParams', id: 'a', set: { length: 10 } }]);
    expect(overlappingEntities(mine, removed)).toEqual(['item:a']);
  });

  test('setParams overlaps per parameter key', () => {
    const withParam = apply(base, { type: 'setParams', id: 'a', set: { length: 5 } });
    const theirs = diffFootprint(
      withParam,
      apply(withParam, { type: 'setParams', id: 'a', set: { length: 6 } }),
    );
    expect(
      overlappingEntities(opFootprint([{ type: 'setParams', id: 'a', set: { width: 1 } }]), theirs),
    ).toEqual([]);
    expect(
      overlappingEntities(opFootprint([{ type: 'setParams', id: 'a', unset: ['length'] }]), theirs),
    ).toEqual(['item:a']);
  });

  test('wall-level fields', () => {
    const renamed = diffFootprint(base, apply(base, { type: 'rename', name: 'Garage' }));
    expect(overlappingEntities(opFootprint([{ type: 'rename', name: 'Mine' }]), renamed)).toEqual([
      'wall:',
    ]);
    expect(
      overlappingEntities(opFootprint([{ type: 'rename', name: 'Tool', itemId: 'a' }]), renamed),
    ).toEqual([]);
  });
});

describe('planReplay', () => {
  test('server unchanged: every edit is clean', () => {
    const edits = [
      edit(1, base.rev, { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } }),
    ];
    const plan = planReplay(base, edits, base);
    expect(plan.edits.map((p) => p.status)).toEqual(['clean']);
    expect(plan.conflicts).toEqual([]);
    expect(plan.diverged).toBe(false);
  });

  test('edits on other items than the server changed are clean', () => {
    const server = apply(base, { type: 'moveItem', id: 'b', to: { cell: { col: 6, row: 6 } } });
    const edits = [
      edit(1, base.rev, { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } }),
    ];
    expect(planReplay(base, edits, server).edits[0]?.status).toBe('clean');
  });

  test('same field changed by both sides is an overlap', () => {
    const server = apply(base, { type: 'moveItem', id: 'a', to: { cell: { col: 9, row: 9 } } });
    const edits = [
      edit(1, base.rev, { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } }),
    ];
    const plan = planReplay(base, edits, server);
    expect(plan.edits[0]).toMatchObject({ status: 'overlap', overlapping: ['item:a'] });
    expect(plan.conflicts).toHaveLength(1);
  });

  test('both sides made the same change: redundant, not a conflict', () => {
    const op: Op = { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } };
    const plan = planReplay(base, [edit(1, base.rev, op)], apply(base, op));
    expect(plan.edits[0]?.status).toBe('redundant');
    expect(plan.conflicts).toEqual([]);
  });

  test('the other side removed the item: inapplicable with the reducer code', () => {
    const server = apply(base, { type: 'removeItem', id: 'a' });
    const edits = [edit(1, base.rev, { type: 'rotateItem', id: 'a', rotZ: 60 })];
    const plan = planReplay(base, edits, server);
    expect(plan.edits[0]).toMatchObject({ status: 'inapplicable', code: 'item_not_found' });
  });

  test('the other side locked the item: inapplicable', () => {
    const server = apply(base, { type: 'lock', id: 'a', locked: true });
    const edits = [edit(1, base.rev, { type: 'rotateItem', id: 'a', rotZ: 60 })];
    expect(planReplay(base, edits, server).edits[0]).toMatchObject({
      status: 'inapplicable',
      code: 'item_locked',
    });
  });

  test('a server older than the base is flagged', () => {
    const older = { ...base, rev: base.rev - 1 };
    expect(planReplay(base, [], older).diverged).toBe(true);
  });
});

describe('resolvePlan', () => {
  const mineMove = { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } } as const;
  const mineRotate = { type: 'rotateItem', id: 'b', rotZ: 60 } as const;
  const edits = [edit(1, base.rev, mineMove), edit(2, base.rev, mineRotate)];
  // The server moved `a` elsewhere (overlaps edit 1) and left `b` alone (edit 2 is clean).
  const server = apply(base, { type: 'moveItem', id: 'a', to: { cell: { col: 9, row: 9 } } });

  test('rebase: replays everything on top of theirs, mine wins the overlap', () => {
    const resolved = resolvePlan(base, edits, server, 'rebase');
    expect(resolved.send.map((e) => e.id)).toEqual([1, 2]);
    expect(resolved.dropped).toEqual([]);
    expect(resolved.wall.items.find((i) => i.id === 'a')?.cell).toEqual({ col: 2, row: 2 });
    expect(resolved.wall.items.find((i) => i.id === 'b')?.pose.rotZ).toBe(60);
  });

  test('keepTheirs: drops the overlapping edit, keeps the clean one', () => {
    const resolved = resolvePlan(base, edits, server, 'keepTheirs');
    expect(resolved.send.map((e) => e.id)).toEqual([2]);
    expect(resolved.dropped).toMatchObject([{ reason: 'overlap' }]);
    expect(resolved.wall.items.find((i) => i.id === 'a')?.cell).toEqual({ col: 9, row: 9 });
  });

  test('keepMine equals rebase while nothing was removed', () => {
    expect(resolvePlan(base, edits, server, 'keepMine').wall).toEqual(
      resolvePlan(base, edits, server, 'rebase').wall,
    );
  });

  test('rebase drops an edit whose item the other side removed', () => {
    const removed = apply(base, { type: 'removeItem', id: 'a' });
    const resolved = resolvePlan(base, edits, removed, 'rebase');
    expect(resolved.send.map((e) => e.id)).toEqual([2]);
    expect(resolved.dropped).toMatchObject([{ reason: 'inapplicable', code: 'item_not_found' }]);
    expect(resolved.wall.items.some((i) => i.id === 'a')).toBe(false);
  });

  test('keepMine brings the removed item back as the user saw it, then applies the edit', () => {
    const removed = apply(base, { type: 'removeItem', id: 'a' });
    const resolved = resolvePlan(base, edits, removed, 'keepMine');
    expect(resolved.restored).toEqual(['item:a']);
    expect(resolved.send.map((e) => e.id)).toEqual([1, 2]);
    expect(resolved.send[0]?.ops.map((op) => op.type)).toEqual(['addItem', 'moveItem']);
    expect(resolved.wall.items.find((i) => i.id === 'a')?.cell).toEqual({ col: 2, row: 2 });
  });

  test('keepMine does not override a lock set by the other side', () => {
    const locked = apply(base, { type: 'lock', id: 'a', locked: true });
    const [mineMoveEdit] = edits;
    if (!mineMoveEdit) throw new Error('fixture');
    const resolved = resolvePlan(base, [mineMoveEdit], locked, 'keepMine');
    expect(resolved.send).toEqual([]);
    expect(resolved.dropped).toMatchObject([{ reason: 'inapplicable', code: 'item_locked' }]);
  });

  test('an id clash drops my addItem; rebase then applies my follow-up to their item, keepTheirs drops it', () => {
    const newItem = holder('n', 4, 4);
    const chain = [
      edit(1, base.rev, { type: 'addItem', item: newItem }),
      edit(2, base.rev, { type: 'rotateItem', id: 'n', rotZ: 60 }),
    ];
    const clash = apply(base, { type: 'addItem', item: { ...newItem, cell: { col: 8, row: 8 } } });
    const rebased = resolvePlan(base, chain, clash, 'rebase');
    expect(rebased.dropped).toMatchObject([{ edit: { id: 1 }, code: 'item_exists' }]);
    expect(rebased.send.map((e) => e.id)).toEqual([2]);
    const theirs = resolvePlan(base, chain, clash, 'keepTheirs');
    expect(theirs.send).toEqual([]);
    expect(theirs.dropped.map((d) => d.edit.id)).toEqual([1, 2]);
  });
});

describe('regressions found in review', () => {
  test('my own edit already on the server does not make my follow-up a conflict', () => {
    const item = holder('n', 4, 4);
    const server = apply(base, { type: 'addItem', item });
    const chain = [
      edit(1, base.rev, { type: 'addItem', item }),
      edit(2, base.rev, { type: 'rotateItem', id: 'n', rotZ: 60 }),
    ];
    const plan = planReplay(base, chain, server);
    expect(plan.edits.map((p) => p.status)).toEqual(['redundant', 'clean']);
    expect(plan.conflicts).toEqual([]);
    // Even "keep theirs" keeps my follow-up: nothing of theirs was involved.
    expect(resolvePlan(base, chain, server, 'keepTheirs').send.map((e) => e.id)).toEqual([2]);
  });

  test('a board change by the other side is not a move of every item', () => {
    const server = apply(base, {
      type: 'setBoard',
      board: { ...base.board, colPitchMm: base.board.colPitchMm + 1 },
    });
    const move = edit(1, base.rev, { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } });
    expect(planReplay(base, [move], server).edits[0]?.status).toBe('clean');
  });

  test('a changed field this vocabulary does not name still counts as the item being edited', () => {
    const touched = {
      ...base,
      items: base.items.map((item) => (item.id === 'a' ? { ...item, brandNewField: 1 } : item)),
    } as unknown as Wall;
    const remove = edit(1, base.rev, { type: 'removeItem', id: 'a' });
    expect(planReplay(base, [remove], touched).edits[0]?.status).toBe('overlap');
  });

  test('subtractFootprint removes only the named fields', () => {
    const fp = opFootprint([
      { type: 'moveItem', id: 'a', to: { cell: { col: 2, row: 2 } } },
      { type: 'rotateItem', id: 'a', rotZ: 60 },
    ]);
    const rest = subtractFootprint(fp, opFootprint([{ type: 'rotateItem', id: 'a', rotZ: 1 }]));
    expect([...(rest.get('item:a') ?? [])]).toEqual(['position']);
  });
});
