import { describe, expect, test } from 'bun:test';
import type { Pose } from '@hsw-editor/core';
import type { NoticeKind } from '@/features/notices/notices.ts';
import { t, tn } from '@/i18n/index.ts';
import { fakeEditor, fakeSeat, holderItem, toolItem, wallOf } from '@/physics/testWall.testkit.ts';
import { seatingStore, seatPhysicsWith } from './seatPhysics.ts';

const SEATED: Pose = { x: 12.5, y: 31, z: 15, rotX: 0, rotY: 90, rotZ: 180 };

function setup(options: { slotted?: boolean } = {}) {
  const tool = toolItem('a', {
    parentId: 'h',
    ...(options.slotted === false ? {} : { slot: 0 }),
    pose: { x: 10, y: 20, z: 40 },
  });
  const editor = fakeEditor(wallOf([holderItem('h', 'rack', { x: 100, y: 50 })], [tool]), () => [
    fakeSeat('h', SEATED),
  ]);
  const told: [NoticeKind, string][] = [];
  let checks = 0;
  const deps = {
    post: editor.deps,
    ensureModels: async () => undefined,
    check: async () => {
      checks++;
    },
    tell: (kind: NoticeKind, text: string) => told.push([kind, text]),
  };
  return { editor, told, deps, checks: () => checks };
}

describe('seatPhysicsWith', () => {
  test('tells how many tools were seated and checks the wall again', async () => {
    const { told, deps, checks } = setup();
    await seatPhysicsWith(deps);
    expect(told).toEqual([['info', tn('physics.seat.done', 1)]]);
    expect(checks()).toBe(1);
    expect(seatingStore.get()).toBe(false);
  });

  test('every tool already where the physics puts it says so', async () => {
    const { editor, told, deps } = setup();
    editor.wall = wallOf(
      [holderItem('h', 'rack', { x: 100, y: 50 })],
      [toolItem('a', { parentId: 'h', slot: 0, pose: SEATED })],
    );
    await seatPhysicsWith(deps);
    expect(told).toEqual([['info', t('physics.seat.nothing')]]);
  });

  test('a tool without a slot number is reported as such, never as already seated', async () => {
    const { told, deps } = setup({ slotted: false });
    await seatPhysicsWith(deps);
    expect(told).toEqual([['error', tn('physics.seat.unslotted', 1)]]);
  });

  test('tools without a seat are reported as not seated', async () => {
    const { editor, told, deps } = setup();
    const none = fakeEditor(editor.wall ?? wallOf([], []), () => []);
    await seatPhysicsWith({ ...deps, post: none.deps });
    expect(told).toEqual([['error', tn('physics.seat.kept', 1)]]);
  });

  test('switched off: told so, nothing runs', async () => {
    const { editor, told, deps, checks } = setup();
    editor.enabled = false;
    await seatPhysicsWith(deps);
    expect(told).toEqual([['info', t('physics.seat.off')]]);
    expect(editor.requests).toEqual([]);
    expect(checks()).toBe(0);
  });

  test('switched off while the worker was busy: told so, not "already seated"', async () => {
    const { editor, told, deps, checks } = setup();
    const busy = fakeEditor(editor.wall ?? wallOf([], []), () => {
      busy.enabled = false;
      return [fakeSeat('h', SEATED)];
    });
    await seatPhysicsWith({ ...deps, post: busy.deps });
    expect(told).toEqual([['info', t('physics.seat.off')]]);
    expect(checks()).toBe(0);
  });

  test('the wall changed meanwhile: an error, nothing moved', async () => {
    const { editor, told, deps } = setup();
    const wall = editor.wall ?? wallOf([], []);
    const racing = fakeEditor(wall, () => {
      racing.wall = { ...wall, rev: wall.rev + 1 };
      return [fakeSeat('h', SEATED)];
    });
    await seatPhysicsWith({ ...deps, post: racing.deps });
    expect(told).toEqual([['error', t('physics.seat.stale')]]);
    expect(racing.submitted).toEqual([]);
  });

  test('a second call while one runs does nothing', async () => {
    const { editor, deps } = setup();
    const gate = Promise.withResolvers<void>();
    const first = seatPhysicsWith({ ...deps, ensureModels: () => gate.promise });
    expect(seatingStore.get()).toBe(true);
    await seatPhysicsWith(deps);
    expect(editor.requests).toEqual([]);
    gate.resolve();
    await first;
    expect(editor.requests).toHaveLength(1);
    expect(seatingStore.get()).toBe(false);
  });
});
