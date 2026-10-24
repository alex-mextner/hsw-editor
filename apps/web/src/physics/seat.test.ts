import { describe, expect, test } from 'bun:test';
import type { Pose } from '@hsw-editor/core';
import { seatOps } from '@hsw-editor/physics';
import { seatAfterHang, seatAllTools, seatToolInHolder } from './seat.ts';
import { fakeEditor, fakeSeat, holderItem, toolItem, wallOf } from './testWall.testkit.ts';

const SEATED: Pose = { x: 12.5, y: 31, z: 15, rotX: 0, rotY: 90, rotZ: 180 };

function hungWall(toolPose: Partial<Pose> = { x: 10, y: 20, z: 40 }) {
  const driver = toolItem('drv', { parentId: 'h', slot: 1, pose: toolPose });
  return wallOf([holderItem('h', 'rack', { x: 100, y: 50 })], [driver]);
}

describe('seatOps', () => {
  test('one undo step: rotate, then move; the slot is untouched', () => {
    expect(seatOps('drv', SEATED)).toEqual({
      type: 'batch',
      label: 'seat',
      ops: [
        { type: 'rotateItem', id: 'drv', rotX: 0, rotY: 90, rotZ: 180 },
        { type: 'moveItem', id: 'drv', to: { x: 12.5, y: 31, z: 15 } },
      ],
    });
  });
});

describe('seatToolInHolder', () => {
  test('asks the worker for the tool in its own slot of the holder, without the removal probe', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    const outcome = await seatToolInHolder('drv', 'h', editor.deps);
    expect(outcome).toMatchObject({ pose: SEATED, slot: 1 });
    const [request] = editor.requests;
    expect(request?.removal).toBe(false);
    expect(request?.candidates.map((c) => c.holder.id)).toEqual(['h']);
    expect(request?.candidates[0]?.tipDown).toBe(true);
  });

  test('null when the worker finds no seat, the holder is unknown or the tool has no model', async () => {
    const none = fakeEditor(hungWall(), () => []);
    expect(await seatToolInHolder('drv', 'h', none.deps)).toBeNull();
    expect(await seatToolInHolder('drv', 'nope', none.deps)).toBeNull();
    const saw = toolItem('saw', { toolClass: 'saw', parentId: 'h' });
    const sawWall = wallOf([holderItem('h', 'rack')], [saw]);
    const sawEditor = fakeEditor(sawWall, () => [fakeSeat('h', SEATED)]);
    expect(await seatToolInHolder('saw', 'h', sawEditor.deps)).toBeNull();
    expect(sawEditor.requests).toEqual([]);
  });
});

describe('seatAfterHang', () => {
  test('moves the hung tool to the seated pose with one batch labelled seat', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    expect(await seatAfterHang('drv', editor.deps)).toBe('seated');
    expect(editor.submitted).toEqual([{ ops: [seatOps('drv', SEATED)], label: 'seat' }]);
  });

  test('a tool whose model is still being rebuilt is seated once the build is in', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    const built = Promise.withResolvers<boolean>();
    const pending = seatAfterHang('drv', { ...editor.deps, settled: () => built.promise });
    await Promise.resolve();
    expect(editor.requests).toEqual([]);
    built.resolve(true);
    expect(await pending).toBe('seated');
    expect(editor.requests).toHaveLength(1);
  });

  test('a tool moved on, or physics switched off, while the model was being rebuilt is left alone', async () => {
    const wall = hungWall();
    const moved = fakeEditor(wall, () => [fakeSeat('h', SEATED)]);
    const afterMove = await seatAfterHang('drv', {
      ...moved.deps,
      settled: async () => {
        moved.wall = hungWall({ x: 99, y: 20, z: 40 });
        return true;
      },
    });
    expect(afterMove).toBe('stale');
    const off = fakeEditor(wall, () => [fakeSeat('h', SEATED)]);
    const afterOff = await seatAfterHang('drv', {
      ...off.deps,
      settled: async () => {
        off.enabled = false;
        return true;
      },
    });
    expect(afterOff).toBe('off');
    expect(moved.requests).toEqual([]);
    expect(off.requests).toEqual([]);
  });

  test('a rebuild that does not finish leaves the tool where it is, without asking the worker', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    expect(await seatAfterHang('drv', { ...editor.deps, settled: async () => false })).toBe('kept');
    expect(editor.requests).toEqual([]);
    expect(editor.submitted).toEqual([]);
  });

  test('no seat keeps the compatibility pose and submits nothing', async () => {
    const editor = fakeEditor(hungWall(), () => []);
    expect(await seatAfterHang('drv', editor.deps)).toBe('kept');
    expect(editor.submitted).toEqual([]);
  });

  test('a seat equal to the current pose is not an edit', async () => {
    const wall = hungWall(SEATED);
    const editor = fakeEditor(wall, () => [fakeSeat('h', SEATED)]);
    expect(await seatAfterHang('drv', editor.deps)).toBe('kept');
    expect(editor.submitted).toEqual([]);
  });

  test('the tool moved by the user while the worker was busy is left alone', async () => {
    const wall = hungWall();
    const editor = fakeEditor(wall, () => {
      editor.wall = hungWall({ x: 99, y: 99, z: 40 });
      return [fakeSeat('h', SEATED)];
    });
    expect(await seatAfterHang('drv', editor.deps)).toBe('stale');
    expect(editor.submitted).toEqual([]);
  });

  test('a tool detached meanwhile is left alone', async () => {
    const editor = fakeEditor(hungWall(), () => {
      const free = toolItem('drv', { pose: { x: 10, y: 20, z: 40 } });
      editor.wall = wallOf([holderItem('h', 'rack', { x: 100, y: 50 })], [free]);
      return [fakeSeat('h', SEATED)];
    });
    expect(await seatAfterHang('drv', editor.deps)).toBe('stale');
  });

  test('switched off: no worker call at all', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    editor.enabled = false;
    expect(await seatAfterHang('drv', editor.deps)).toBe('off');
    expect(editor.requests).toEqual([]);
  });

  test('a tool that does not hang anywhere is skipped', async () => {
    const free = toolItem('drv');
    const editor = fakeEditor(wallOf([holderItem('h', 'rack')], [free]), () => [
      fakeSeat('h', SEATED),
    ]);
    expect(await seatAfterHang('drv', editor.deps)).toBe('skipped');
  });

  test('a refused submit (locked item, closed wall) reports stale', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)], { submitOk: false });
    expect(await seatAfterHang('drv', editor.deps)).toBe('stale');
  });

  test('a worker failure only keeps the compatibility pose', async () => {
    const editor = fakeEditor(hungWall(), () => {
      throw new Error('worker died');
    });
    expect(await seatAfterHang('drv', editor.deps)).toBe('failed');
    expect(editor.submitted).toEqual([]);
  });
});

const toolPoseOfB = { x: 50, y: 20, z: 40, rotX: 0, rotY: 0, rotZ: 0 };

describe('seatAllTools', () => {
  function twoTools() {
    const a = toolItem('a', { parentId: 'h', slot: 0, pose: { x: 10, y: 20, z: 40 } });
    const b = toolItem('b', { parentId: 'h', slot: 1, pose: { x: 50, y: 20, z: 40 } });
    const loose = toolItem('loose');
    const fixed = toolItem('fixed', { parentId: 'h', slot: 2, pose: SEATED });
    return wallOf([holderItem('h', 'rack', { x: 100, y: 50 })], [a, b, loose, fixed]);
  }

  test('seats every hung tool as ONE undo step, the already seated one is left out', async () => {
    const editor = fakeEditor(twoTools(), (request) => [
      fakeSeat(
        'h',
        request.tool.id === 'fixed' ? SEATED : { ...SEATED, x: request.tool.id === 'a' ? 1 : 2 },
      ),
    ]);
    const outcome = await seatAllTools(editor.deps);
    expect(outcome).toMatchObject({
      seated: ['a', 'b'],
      unchanged: ['fixed'],
      kept: [],
      stale: false,
    });
    expect(editor.submitted).toHaveLength(1);
    const [step] = editor.submitted;
    expect(step?.label).toBe('seat all');
    expect(step?.ops).toEqual([
      {
        type: 'batch',
        label: 'seat all',
        ops: [...seatOps('a', { ...SEATED, x: 1 }).ops, ...seatOps('b', { ...SEATED, x: 2 }).ops],
      },
    ]);
  });

  test('each tool is seated against the poses the earlier ones already have', async () => {
    const wall = twoTools();
    const seenAtB: number[] = [];
    const editor = fakeEditor(wall, (request) => {
      if (request.tool.id === 'b') {
        seenAtB.push(...request.neighbours.filter((n) => n.id === 'a').map((n) => n.pose.x));
      }
      return [fakeSeat('h', { ...SEATED, x: request.tool.id === 'a' ? 1 : 2 })];
    });
    await seatAllTools(editor.deps);
    expect(seenAtB).toEqual([1]);
  });

  test('a tool is seated among the tools already dealt with, not among those still waiting at their old poses', async () => {
    const seen: Record<string, string[]> = {};
    const editor = fakeEditor(twoTools(), (request) => {
      seen[request.tool.id] = request.neighbours
        .filter((n) => n.id !== 'h' && n.id !== 'loose')
        .map((n) => n.id);
      return [fakeSeat('h', { ...SEATED, x: 1 })];
    });
    await seatAllTools(editor.deps);
    expect(seen['a']).toEqual([]);
    expect(seen['b']).toEqual(['a']);
    expect(seen['fixed']).toEqual(['a', 'b']);
  });

  test('a locked hung tool stays an obstacle for every tool seated before it', async () => {
    const a = toolItem('a', { parentId: 'h', slot: 0, pose: { x: 10, y: 20, z: 40 } });
    const locked = {
      ...toolItem('locked', { parentId: 'h', slot: 1, pose: SEATED }).item,
      locked: true,
    };
    const wall = wallOf([holderItem('h', 'rack', { x: 100, y: 50 })], [a]);
    const withLocked = { ...wall, items: [...wall.items, locked] };
    const seen: string[][] = [];
    const editor = fakeEditor(withLocked, (request) => {
      seen.push(request.neighbours.filter((n) => n.id !== 'h').map((n) => n.id));
      return [fakeSeat('h', SEATED)];
    });
    await seatAllTools(editor.deps);
    expect(seen).toEqual([['locked']]);
  });

  test('tools without a seat are kept and reported, nothing is submitted when nothing moves', async () => {
    const editor = fakeEditor(twoTools(), () => []);
    const outcome = await seatAllTools(editor.deps);
    expect(outcome.kept).toEqual(['a', 'b', 'fixed']);
    expect(outcome.seated).toEqual([]);
    expect(editor.submitted).toEqual([]);
  });

  test('physics checks off does nothing; a wall edited meanwhile applies nothing', async () => {
    const off = fakeEditor(twoTools(), () => [fakeSeat('h', SEATED)]);
    off.enabled = false;
    expect(await seatAllTools(off.deps)).toMatchObject({ seated: [], stale: false });
    expect(off.requests).toEqual([]);

    const wall = twoTools();
    const editor = fakeEditor(wall, () => {
      editor.wall = { ...wall, rev: wall.rev + 1 };
      return [fakeSeat('h', { ...SEATED, x: 1 })];
    });
    expect(await seatAllTools(editor.deps)).toMatchObject({ seated: [], stale: true });
    expect(editor.submitted).toEqual([]);
  });

  test('tools without a slot number are left alone and stay obstacles', async () => {
    const a = toolItem('a', { parentId: 'h', slot: 0, pose: { x: 10, y: 20, z: 40 } });
    const nameless = toolItem('nameless', { parentId: 'h', pose: { x: 50, y: 20, z: 40 } });
    const wall = wallOf([holderItem('h', 'rack', { x: 100, y: 50 })], [a, nameless]);
    const seen: string[][] = [];
    const editor = fakeEditor(wall, (request) => {
      seen.push(request.neighbours.filter((n) => n.id !== 'h').map((n) => n.id));
      return [fakeSeat('h', SEATED)];
    });
    const outcome = await seatAllTools(editor.deps);
    expect(outcome).toMatchObject({ seated: ['a'], kept: [], unslotted: ['nameless'] });
    expect(seen).toEqual([['nameless']]);
  });

  test('another wall opened meanwhile with the same revision gets nothing', async () => {
    const wall = twoTools();
    const editor = fakeEditor(wall, () => {
      editor.wall = { ...wall, id: 'other' };
      return [fakeSeat('h', { ...SEATED, x: 1 })];
    });
    expect(await seatAllTools(editor.deps)).toMatchObject({ seated: [], stale: true });
    expect(editor.submitted).toEqual([]);
  });

  test('a seated tool looks again once the tools that did not move are known, and settles away from them', async () => {
    const calls: Record<string, string[][]> = {};
    const editor = fakeEditor(twoTools(), (request) => {
      const seenNow = request.neighbours
        .filter((n) => n.id === 'b' || n.id === 'fixed')
        .map((n) => n.id);
      (calls[request.tool.id] ??= []).push(seenNow);
      if (request.tool.id === 'fixed') return [fakeSeat('h', SEATED)];
      // `b` does not move (it is already there); `a` first has nothing near it, the second time `fixed` is there.
      if (request.tool.id === 'b') return [fakeSeat('h', { ...toolPoseOfB })];
      return [fakeSeat('h', { ...SEATED, x: seenNow.length === 0 ? 1 : 5 })];
    });
    const outcome = await seatAllTools(editor.deps);
    expect(calls['a']).toEqual([[], ['b', 'fixed']]);
    expect(outcome.seated).toContain('a');
    const [step] = editor.submitted;
    const batch = step?.ops[0];
    expect(batch?.type === 'batch' ? batch.ops : []).toEqual(seatOps('a', { ...SEATED, x: 5 }).ops);
  });

  test('a tool the second look puts back where it began is not a move: no undo step, not counted', async () => {
    const wall = twoTools();
    const home = wall.items.find((i) => i.id === 'a')?.pose ?? SEATED;
    const editor = fakeEditor(wall, (request) => {
      if (request.tool.id === 'a') {
        const sees = request.neighbours.some((n) => n.id === 'fixed');
        return [fakeSeat('h', sees ? home : { ...SEATED, x: 1 })];
      }
      return [
        fakeSeat(
          'h',
          request.tool.id === 'fixed'
            ? SEATED
            : (wall.items.find((i) => i.id === request.tool.id)?.pose ?? SEATED),
        ),
      ];
    });
    const outcome = await seatAllTools(editor.deps);
    expect(outcome.seated).toEqual([]);
    expect(editor.submitted).toEqual([]);
  });

  test('switched off while the worker was busy: nothing is applied', async () => {
    const editor = fakeEditor(twoTools(), () => {
      editor.enabled = false;
      return [fakeSeat('h', { ...SEATED, x: 1 })];
    });
    expect(await seatAllTools(editor.deps)).toMatchObject({ seated: [], stale: false });
    expect(editor.submitted).toEqual([]);
  });
});
