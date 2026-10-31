import { describe, expect, test } from 'bun:test';
import { FLOOR_DEPTH_MM, FLOOR_Y_MM, type LeafOp, type Pose } from '@hsw-editor/core';
import { DISTURBANCES, type HangReport } from '@hsw-editor/physics';
import type { PhysicsFaller } from './client.ts';
import { fallOps, releaseFree, type FallDeps, type FreeRelease } from './fall.ts';
import type { FallRequest, FellPlan } from './protocol.ts';
import { fakeEditor, holderItem, toolItem, wallOf, type FakeEditor } from './testWall.testkit.ts';

const REST: Pose = { x: 300, y: -231, z: 41, rotX: 90, rotY: 0, rotZ: 90 };
const MARGINS = Object.fromEntries(
  Object.keys(DISTURBANCES).map((name) => [name, 0]),
) as HangReport['marginsG'];

function report(code: 'levitating' | null): HangReport {
  return {
    score: code === null ? 0.9 : 0,
    status: code === null ? 'stable' : 'unstable',
    reasons: code === null ? [] : [{ code, params: { gapMm: 40 } }],
    marginsG: MARGINS,
    massG: 100,
    contactCount: code === null ? 2 : 0,
    penetrationMm: 0,
    swingDeg: null,
    rest: null,
  };
}

const FALLS: FellPlan = {
  falls: true,
  report: report('levitating'),
  rest: REST,
  dropMm: 640,
  landedOn: null,
};
const HOLDS: FellPlan = { falls: false, report: report(null) };

const RELEASED: Pose = { x: 300, y: 400, z: 40, rotX: 0, rotY: 0, rotZ: 180 };

/** A tool pulled off its holder and let go in mid air, with one other hung tool beside it. */
function scene(): { editor: FakeEditor; release: FreeRelease } {
  const wall = wallOf(
    [holderItem('h', 'rack', { x: 100, y: 50 })],
    [
      toolItem('drv', { parentId: 'h', slot: 0, pose: { x: 90, y: 60, z: 30 } }),
      toolItem('other', { parentId: 'h', slot: 1, pose: { x: 110, y: 60, z: 30 } }),
    ],
  );
  const release: FreeRelease = {
    toolId: 'drv',
    ops: [
      { type: 'attachItem', id: 'drv', parentId: null },
      { type: 'moveItem', id: 'drv', to: { x: RELEASED.x, y: RELEASED.y } },
      { type: 'rotateItem', id: 'drv', rotZ: RELEASED.rotZ },
    ],
    label: 'move-item',
  };
  return { editor: fakeEditor(wall, () => []), release };
}

function depsOf(
  editor: FakeEditor,
  answer: (request: FallRequest) => Promise<FellPlan | null>,
  asked: FallRequest[] = [],
): FallDeps {
  const faller: PhysicsFaller = {
    fall: async (request) => {
      asked.push(request);
      return answer(request);
    },
  };
  return {
    wall: editor.deps.wall,
    context: editor.deps.context,
    submit: editor.deps.submit,
    enabled: editor.deps.enabled,
    faller: () => faller,
  };
}

describe('fallOps', () => {
  test('turns the tool into its lying pose, then moves it to where it rests', () => {
    expect(fallOps('drv', REST)).toEqual([
      { type: 'rotateItem', id: 'drv', rotX: 90, rotY: 0, rotZ: 90 },
      { type: 'moveItem', id: 'drv', to: { x: 300, y: -231, z: 41 } },
    ]);
  });
});

describe('releaseFree', () => {
  test('a tool nothing holds falls: one undo step carries the release and the fall', async () => {
    const { editor, release } = scene();
    const asked: FallRequest[] = [];
    const outcome = await releaseFree(
      release,
      depsOf(editor, async () => FALLS, asked),
    );
    expect(outcome).toEqual({ kind: 'fell', to: REST, dropMm: 640, landedOn: null });
    expect(editor.submitted).toEqual([
      {
        ops: [{ type: 'batch', label: 'fall', ops: [...release.ops, ...fallOps('drv', REST)] }],
        label: 'fall',
      },
    ]);
    // judged at the pose it was released at, against the rest of the wall, above the floor of the wall
    const [request] = asked;
    expect(request?.tool.id).toBe('drv');
    expect(request?.tool.pose).toMatchObject({ x: 300, y: 400, rotZ: 180 });
    expect(request?.neighbours.map((body) => body.id).sort()).toEqual(['h', 'other']);
    expect(request?.floorYMm).toBe(FLOOR_Y_MM);
    expect(request?.floorDepthMm).toBe(FLOOR_DEPTH_MM);
  });

  test('a tool something holds stays where it was put, as one ordinary move', async () => {
    const { editor, release } = scene();
    expect(
      await releaseFree(
        release,
        depsOf(editor, async () => HOLDS),
      ),
    ).toEqual({ kind: 'placed' });
    expect(editor.submitted).toEqual([{ ops: release.ops, label: 'move-item' }]);
  });

  test('physics checks switched off: no decision is asked, the tool is placed', async () => {
    const { editor, release } = scene();
    editor.enabled = false;
    const asked: FallRequest[] = [];
    expect(
      await releaseFree(
        release,
        depsOf(editor, async () => FALLS, asked),
      ),
    ).toEqual({
      kind: 'placed',
    });
    expect(asked).toEqual([]);
    expect(editor.submitted).toEqual([{ ops: release.ops, label: 'move-item' }]);
  });

  test('a tool without a generated model is placed (a stand-in box has no centre of gravity)', async () => {
    const saw = toolItem('saw', { toolClass: 'saw', pose: { x: 10, y: 10 } });
    const wall = wallOf([holderItem('h', 'rack')], [saw]);
    const editor = fakeEditor(wall, () => []);
    const ops: LeafOp[] = [{ type: 'moveItem', id: 'saw', to: { x: 300, y: 400 } }];
    const asked: FallRequest[] = [];
    const outcome = await releaseFree(
      { toolId: 'saw', ops, label: 'move-item' },
      depsOf(editor, async () => FALLS, asked),
    );
    expect(outcome).toEqual({ kind: 'placed' });
    expect(asked).toEqual([]);
  });

  test('a failing or unusable worker leaves the tool where it was put', async () => {
    const { editor, release } = scene();
    const failed = await releaseFree(
      release,
      depsOf(editor, async () => {
        throw new Error('worker gone');
      }),
    );
    expect(failed).toEqual({ kind: 'placed' });
    const unusable = await releaseFree(
      release,
      depsOf(editor, async () => null),
    );
    expect(unusable).toEqual({ kind: 'placed' });
    expect(editor.submitted.map((step) => step.label)).toEqual(['move-item', 'move-item']);
  });

  test('a decision that takes too long is not waited for', async () => {
    const { editor, release } = scene();
    const never = new Promise<FellPlan | null>(() => undefined);
    const outcome = await releaseFree(
      release,
      depsOf(editor, () => never),
      5,
    );
    expect(outcome).toEqual({ kind: 'placed' });
  });

  test('an edit of the wall while the worker was busy drops the fall: the tool is only placed', async () => {
    const { editor, release } = scene();
    const outcome = await releaseFree(
      release,
      depsOf(editor, async () => {
        const wall = editor.wall;
        if (wall !== null) editor.wall = { ...wall, rev: wall.rev + 1 };
        return FALLS;
      }),
    );
    expect(outcome).toEqual({ kind: 'placed' });
    expect(editor.submitted).toEqual([{ ops: release.ops, label: 'move-item' }]);
  });

  test('ops the wall does not take are submitted as they are, so the refusal reaches the caller', async () => {
    const { editor, release } = scene();
    const bad: FreeRelease = {
      ...release,
      ops: [{ type: 'moveItem', id: 'ghost', to: { x: 1, y: 2 } }],
    };
    const asked: FallRequest[] = [];
    const refused = fakeEditor(editor.wall ?? wallOf([], []), () => [], { submitOk: false });
    expect(
      await releaseFree(
        bad,
        depsOf(refused, async () => FALLS, asked),
      ),
    ).toEqual({
      kind: 'refused',
    });
    expect(asked).toEqual([]);
  });

  test('another wall opened meanwhile: the release is dropped, not added to the new wall', async () => {
    const { editor, release } = scene();
    const outcome = await releaseFree(
      release,
      depsOf(editor, async () => {
        const wall = editor.wall;
        if (wall !== null) editor.wall = { ...wall, id: 'other-wall' };
        return FALLS;
      }),
    );
    expect(outcome).toEqual({ kind: 'refused' });
    expect(editor.submitted).toEqual([]);
  });

  test('a newer release of the same tool supersedes an older one still waiting', async () => {
    const { editor, release } = scene();
    const slow = Promise.withResolvers<FellPlan | null>();
    const older = releaseFree(
      release,
      depsOf(editor, () => slow.promise),
    );
    const newer = await releaseFree(
      { ...release, label: 'newer' },
      depsOf(editor, async () => HOLDS),
    );
    slow.resolve(FALLS);
    expect(newer).toEqual({ kind: 'placed' });
    expect(await older).toEqual({ kind: 'refused' });
    expect(editor.submitted.map((step) => step.label)).toEqual(['newer']);
  });

  test('a model that never settles counts against the same deadline as the worker', async () => {
    const { editor, release } = scene();
    const never = new Promise<boolean>(() => undefined);
    const outcome = await releaseFree(
      release,
      { ...depsOf(editor, async () => FALLS), settled: () => never },
      5,
    );
    expect(outcome).toEqual({ kind: 'placed' });
  });
});
