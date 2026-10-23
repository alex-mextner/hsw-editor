import { describe, expect, test } from 'bun:test';
import type { Pose } from '@hsw-editor/core';
import { samePose, seatAfterHang, seatOps, seatToolInHolder } from './seat.ts';
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
    const editor = fakeEditor(wallOf([holderItem('h', 'rack')], [free]), () => [fakeSeat('h', SEATED)]);
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

describe('samePose', () => {
  test('compares every component within 0.01', () => {
    expect(samePose(SEATED, { ...SEATED, x: 12.504 })).toBe(true);
    expect(samePose(SEATED, { ...SEATED, rotY: 91 })).toBe(false);
  });
});
