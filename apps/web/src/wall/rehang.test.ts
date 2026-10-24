import { describe, expect, test } from 'bun:test';
import type { Pose } from '@hsw-editor/core';
import { seatOps } from '@hsw-editor/physics';
import {
  fakeEditor,
  fakeSeat,
  holderItem,
  RACK,
  toolItem,
  wallOf,
} from '@/physics/testWall.testkit.ts';
import { rehangWith, type RehangDeps } from './rehang.ts';

const SEATED: Pose = { x: 112.5, y: 71, z: 15, rotX: 0, rotY: 0, rotZ: 180 };

/** A screwdriver hung in slot 0 of a rack, at a pose that is not where a drop would put it. */
function hungWall(poses: Partial<Pose> = { x: 110, y: 60, z: 40 }) {
  const driver = toolItem('drv', {
    parentId: 'h',
    slot: 0,
    pose: poses,
    params: { shaftDiameter: 4 },
  });
  return wallOf([holderItem('h', RACK.id, { x: 100, y: 50 })], [driver]);
}

function depsOf(editor: ReturnType<typeof fakeEditor>, settled = true): RehangDeps {
  return { post: editor.deps, settled: async () => settled };
}

describe('rehangWith', () => {
  test('re-seats the resized tool in its own slot: one undo step labelled rehang with the seated pose', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    expect(await rehangWith(depsOf(editor), 'drv')).toBe('seated');
    expect(editor.submitted).toEqual([{ ops: [seatOps('drv', SEATED)], label: 'rehang' }]);
    // The rebuilt model is lowered into the slot the tool already occupies, without the removal probe.
    expect(editor.requests).toHaveLength(1);
    expect(editor.requests[0]?.removal).toBe(false);
    expect(editor.requests[0]?.candidates.map((c) => c.holder.id)).toEqual(['h']);
  });

  test('without a seat the compatibility pose of a drop is used, as before', async () => {
    const editor = fakeEditor(hungWall(), () => []);
    expect(await rehangWith(depsOf(editor), 'drv')).toBe('replaced');
    const [step] = editor.submitted;
    expect(step?.label).toBe('rehang');
    expect(step?.ops[0]).toMatchObject({ type: 'batch', label: 'hang' });
  });

  test('physics checks off: no worker, the compatibility pose', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    editor.enabled = false;
    expect(await rehangWith(depsOf(editor), 'drv')).toBe('replaced');
    expect(editor.requests).toEqual([]);
  });

  test('a tool already at the seated pose makes no undo step', async () => {
    const editor = fakeEditor(hungWall(SEATED), () => [fakeSeat('h', SEATED)]);
    expect(await rehangWith(depsOf(editor), 'drv')).toBe('unchanged');
    expect(editor.submitted).toEqual([]);
  });

  test('the rebuild taking too long, a loose tool and a locked tool are left alone', async () => {
    const slow = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)]);
    expect(await rehangWith(depsOf(slow, false), 'drv')).toBe('skipped');
    expect(slow.requests).toEqual([]);

    const loose = toolItem('loose');
    const looseEditor = fakeEditor(wallOf([], [loose]), () => [fakeSeat('h', SEATED)]);
    expect(await rehangWith(depsOf(looseEditor), 'loose')).toBe('skipped');

    const wall = hungWall();
    const lockedEditor = fakeEditor(
      { ...wall, items: wall.items.map((i) => (i.id === 'drv' ? { ...i, locked: true } : i)) },
      () => [fakeSeat('h', SEATED)],
    );
    expect(await rehangWith(depsOf(lockedEditor), 'drv')).toBe('skipped');
    expect(lockedEditor.submitted).toEqual([]);
  });

  test('the tool moved or was edited while the worker was busy: nothing is submitted', async () => {
    const wall = hungWall();
    const editor = fakeEditor(wall, () => {
      // The user drags the tool on while the seat is being computed.
      editor.wall = {
        ...wall,
        items: wall.items.map((i) =>
          i.id === 'drv' ? { ...i, pose: { ...i.pose, x: i.pose.x + 30 } } : i,
        ),
      };
      return [fakeSeat('h', SEATED)];
    });
    expect(await rehangWith(depsOf(editor), 'drv')).toBe('skipped');
    expect(editor.submitted).toEqual([]);
  });

  test('a refused submit is not reported as done', async () => {
    const editor = fakeEditor(hungWall(), () => [fakeSeat('h', SEATED)], { submitOk: false });
    expect(await rehangWith(depsOf(editor), 'drv')).toBe('skipped');
  });

  test('physics checks off: a tool moved to another slot while the model was building is not touched', async () => {
    const wall = hungWall();
    const editor = fakeEditor(wall, () => []);
    editor.enabled = false;
    const moved = {
      ...wall,
      items: wall.items.map((i) =>
        i.id === 'drv' ? { ...i, slot: 2, pose: { ...i.pose, x: i.pose.x + 40 } } : i,
      ),
    };
    const deps: RehangDeps = {
      post: editor.deps,
      settled: async () => {
        editor.wall = moved;
        return true;
      },
    };
    expect(await rehangWith(deps, 'drv')).toBe('skipped');
    expect(editor.submitted).toEqual([]);
  });

  test('another wall opened while the model was building is not touched', async () => {
    const wall = hungWall();
    const editor = fakeEditor(wall, () => [fakeSeat('h', SEATED)]);
    const deps: RehangDeps = {
      post: editor.deps,
      settled: async () => {
        editor.wall = { ...wall, id: 'other' };
        return true;
      },
    };
    expect(await rehangWith(deps, 'drv')).toBe('skipped');
    expect(editor.submitted).toEqual([]);
  });

  test('another edit while the seat was being computed leaves the tool where it is', async () => {
    const wall = hungWall();
    const editor = fakeEditor(wall, () => {
      editor.wall = { ...wall, rev: wall.rev + 1 };
      return [fakeSeat('h', SEATED)];
    });
    expect(await rehangWith(depsOf(editor), 'drv')).toBe('skipped');
    expect(editor.submitted).toEqual([]);
  });
});
