import { describe, expect, test } from 'bun:test';
import { wallSlot } from '@hsw-editor/compat';
import { loadLimitG } from '@hsw-editor/physics';
import { buildPhysicsScene, planVirtualRank, planWallRank } from './assets.ts';
import {
  contextOf,
  HOOK,
  HOOK_CAPPED,
  holderItem,
  POSE,
  RACK,
  toolItem,
  wallOf,
} from './testWall.testkit.ts';

describe('buildPhysicsScene', () => {
  const driver = toolItem('drv', { parentId: 'h', slot: 1, pose: { x: 10, y: 20 } });
  const loose = toolItem('loose');
  const wall = wallOf(
    [holderItem('h', 'rack', { x: 100, y: 50 }), holderItem('hk', 'hook')],
    [driver, loose],
  );

  test('holders carry their bank model by absolute url and their pose', () => {
    const { scene, sources } = buildPhysicsScene(wall, contextOf(wall));
    expect(scene.holders.map((h) => [h.id, h.bodyKey, h.pose.x])).toEqual([
      ['h', 'rack', 100],
      ['hk', 'hook', 0],
    ]);
    const rack = sources.get('rack');
    expect(rack?.kind).toBe('solid');
    expect(rack?.url).toMatch(/^http:\/\/wall\.test\/bank\/assets\/glb\/.+\.glb$/);
  });

  test('a hung tool names its holder and the load the slot carries, a loose tool has neither', () => {
    const { scene, sources } = buildPhysicsScene(wall, contextOf(wall));
    const [hung, free] = scene.tools;
    expect(hung).toMatchObject({
      id: 'drv',
      holderId: 'h',
      maxLoadG: 1000,
      pose: { x: 10, y: 20 },
    });
    expect(free).toMatchObject({ id: 'loose', holderId: null });
    expect(free?.maxLoadG).toBeUndefined();
    const source = sources.get(hung?.bodyKey ?? '');
    expect(source).toEqual({
      kind: 'tool',
      url: 'http://wall.test/api/tools/classes/screwdriver/model.glb?lod=1&p=%7B%7D',
    });
  });

  test('tools without a resolvable model are not in the scene', () => {
    const saw = toolItem('saw', { toolClass: 'saw', parentId: 'h' });
    const withSaw = wallOf([holderItem('h', 'rack')], [saw]);
    expect(buildPhysicsScene(withSaw, contextOf(withSaw)).scene.tools).toEqual([]);
  });
});

describe('loadLimitG', () => {
  const tool = {
    toolClass: 'screwdriver',
    lengthMm: 200,
    hang: null,
    maxSection: { w: 10, t: 10, r: 7 },
    dims: {},
  };

  test('the bank number of the matched mount entry wins', () => {
    expect(loadLimitG(tool, HOOK_CAPPED)).toBe(300);
  });

  test('without one the category default applies: slot holders 1000 g, hooks 1500 g', () => {
    expect(loadLimitG(tool, RACK)).toBe(1000);
    expect(loadLimitG({ ...tool, toolClass: 'pliers' }, HOOK)).toBe(1500);
    expect(loadLimitG(undefined, RACK)).toBe(1000);
  });
});

describe('planWallRank', () => {
  const driver = toolItem('drv', { parentId: 'h', slot: 1 });
  const wall = wallOf(
    [holderItem('h', 'rack', { x: 100, y: 50 }), holderItem('far', 'rack', { x: 5000, y: 50 })],
    [driver],
  );
  const ctx = contextOf(wall);
  const tool = ctx.toolInterface(driver.item);

  test('the candidate sits on the slot anchor, the window is half the slot pitch, a screwdriver goes tip down', () => {
    const slot =
      tool === undefined ? null : wallSlot(wall, driver.item, wall.items[0]!, RACK, tool, 1);
    if (slot === null) throw new Error('no slot');
    const plan = planWallRank(wall, ctx, driver.item, [slot], true);
    const [candidate] = plan?.request.candidates ?? [];
    // Slot 1 of 4 across 120 mm: centre at -30 + 15 = -15 -> x 85; holder top (y max 20) at 50 + 20; z mid 15.
    expect(candidate?.anchor).toEqual([85, 70, 15]);
    expect(candidate?.halfWidthMm).toBe(14);
    expect(candidate?.tipDown).toBe(true);
    expect(candidate?.maxLoadG).toBe(1000);
    expect(plan?.request.removal).toBe(true);
    expect(plan?.request.tool.id).toBe('drv');
  });

  test('only bodies near the holder are obstacles, never the tool itself', () => {
    const slot =
      tool === undefined ? null : wallSlot(wall, driver.item, wall.items[0]!, RACK, tool, 0);
    if (slot === null) throw new Error('no slot');
    const plan = planWallRank(wall, ctx, driver.item, [slot], false);
    const ids = plan?.request.neighbours.map((b) => b.id) ?? [];
    expect(ids).toContain('h');
    expect(ids).not.toContain('far');
    expect(ids).not.toContain('drv');
  });

  test('a rotated holder is not seated: no plan', () => {
    const turned = wallOf([holderItem('h', 'rack', { rotZ: 90 })], [driver]);
    const turnedCtx = contextOf(turned);
    const slot = wallSlot(turned, driver.item, turned.items[0]!, RACK, tool!, 0);
    expect(slot).not.toBeNull();
    if (slot !== null)
      expect(planWallRank(turned, turnedCtx, driver.item, [slot], false)).toBeNull();
  });

  test('a tool without a model has no plan', () => {
    const saw = toolItem('saw', { toolClass: 'saw', parentId: 'h' });
    const sawWall = wallOf([holderItem('h', 'rack')], [saw]);
    expect(planWallRank(sawWall, contextOf(sawWall), saw.item, [], false)).toBeNull();
  });
});

describe('wallSlot', () => {
  test('takes the first slot nobody uses unless one is asked for', () => {
    const a = toolItem('a', { parentId: 'h', slot: 0 });
    const b = toolItem('b', { parentId: 'h' });
    const wall = wallOf([holderItem('h', 'rack')], [a, b]);
    const tool = contextOf(wall).toolInterface(b.item);
    if (tool === undefined) throw new Error('no interface');
    expect(wallSlot(wall, b.item, wall.items[0]!, RACK, tool)?.slot.index).toBe(1);
    expect(wallSlot(wall, b.item, wall.items[0]!, RACK, tool, 3)?.slot.index).toBe(3);
    expect(wallSlot(wall, b.item, wall.items[0]!, RACK, tool, 9)).toBeNull();
  });
});

describe('planVirtualRank', () => {
  test('a suggested holder is judged standing alone at the origin, with the tool model of the item', () => {
    const driver = toolItem('drv');
    const wall = wallOf([], [driver]);
    const plan = planVirtualRank(wall, contextOf(wall), driver.item, RACK);
    expect(plan?.request.neighbours).toEqual([]);
    expect(plan?.request.candidates[0]?.holder).toMatchObject({
      id: 'virtual:rack',
      bodyKey: 'rack',
      pose: POSE,
    });
    expect(plan?.sources.get('rack')?.kind).toBe('solid');
    expect(plan?.request.removal).toBe(true);
  });

  test('a holder the tool does not fit gets no plan', () => {
    const pliers = toolItem('pl', { toolClass: 'pliers' });
    const wall = wallOf([], [pliers]);
    expect(planVirtualRank(wall, contextOf(wall), pliers.item, RACK)).toBeNull();
  });
});
