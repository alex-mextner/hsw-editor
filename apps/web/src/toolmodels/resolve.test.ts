import { describe, expect, test } from 'bun:test';
import { installFetch, restoreFetch, settleRequests } from '@/test/fetchStub.ts';
import { createEmptyWall, WallItemSchema, type ModelRef, type Wall } from '@hsw-editor/core';
import { ModelRegen } from './regen.ts';
import {
  entryOfTool,
  generatorRef,
  resolveToolModel,
  wantedDims,
  type ResolveDeps,
} from './resolve.ts';
import { FakeRegenPort, FakeUrls, classEntry, readyState, userToolEntry } from './testing.ts';

const screwdriver = classEntry('screwdriver', 'screwdriver');
const pliers = classEntry('pliers-combination', 'pliers');
const hammer = classEntry('hammer', 'hammer');

function model(patch: Partial<ModelRef> = {}): ModelRef {
  return {
    id: 'm-1',
    label: 'Tool',
    status: 'chosen',
    source: { type: 'library', by: 'preset' },
    ...patch,
  };
}

function wallWith(item: ReturnType<typeof tool>, ref?: ModelRef): Wall {
  return { ...createEmptyWall('w-1', 'Wall'), items: [item], models: ref ? [ref] : [] };
}

function tool(patch: Record<string, unknown> = {}) {
  return WallItemSchema.parse({
    id: 'i-1',
    kind: 'tool',
    modelRefId: 'm-1',
    toolClass: 'screwdriver',
    ...patch,
  });
}

function deps(entries = [screwdriver, pliers, hammer]) {
  const port = new FakeRegenPort();
  const regen = new ModelRegen(
    () => port,
    new FakeUrls(),
    () => undefined,
  );
  let ensured = 0;
  const d: ResolveDeps = { state: () => readyState(entries), ensure: () => (ensured += 1), regen };
  return { d, port, ensured: () => ensured };
}

describe('generatorRef', () => {
  test('reads the class and library tool a model reference names', () => {
    expect(generatorRef('gen:screwdriver')).toEqual({ kind: 'class', id: 'screwdriver' });
    expect(generatorRef('tool:my-1')).toEqual({ kind: 'tool', id: 'my-1' });
    expect(generatorRef('preset')).toBeNull();
    expect(generatorRef(undefined)).toBeNull();
  });
});

describe('entryOfTool', () => {
  const state = readyState([screwdriver, pliers, hammer, userToolEntry('mine', screwdriver)]);

  test('the generator the model reference names wins over the bank class', () => {
    const wall = wallWith(
      tool({ toolClass: 'pliers' }),
      model({ source: { type: 'library', by: 'gen:hammer' } }),
    );
    expect(entryOfTool(wall.items[0]!, wall, state)?.id).toBe('class:hammer');
  });

  test('a library tool is drawn from its own stored model', () => {
    const wall = wallWith(tool(), model({ source: { type: 'library', by: 'tool:mine' } }));
    expect(entryOfTool(wall.items[0]!, wall, state)?.id).toBe('tool:mine');
  });

  test('without a named generator the bank class (then its broader class) picks one; unknown classes have none', () => {
    const wall = wallWith(tool({ toolClass: 'pliers' }), model());
    expect(entryOfTool(wall.items[0]!, wall, state)?.id).toBe('class:pliers-combination');
    expect(
      entryOfTool(wall.items[0]!, wall, state, [{ id: 'hex-key', broader: 'screwdriver' }])?.id,
    ).toBe('class:pliers-combination');
    const odd = wallWith(tool({ toolClass: 'hex-key' }), model());
    expect(
      entryOfTool(odd.items[0]!, odd, state, [{ id: 'hex-key', broader: 'screwdriver' }])?.id,
    ).toBe('class:screwdriver');
    const none = wallWith(tool({ toolClass: 'usb-stick' }), model());
    expect(entryOfTool(none.items[0]!, none, state)).toBeUndefined();
  });

  test('nothing resolves before the index is loaded', () => {
    const wall = wallWith(tool(), model());
    expect(entryOfTool(wall.items[0]!, wall, { status: 'loading' })).toBeUndefined();
  });
});

describe('wantedDims', () => {
  test('only what the user typed counts; a preset box and a detected size are told apart', () => {
    const wall = wallWith(
      tool({ params: { length: 180 } }),
      model({ dimensionsMm: { x: 28, y: 210, z: 28 } }),
    );
    expect(wantedDims(wall.items[0]!, wall)).toEqual({ y: 180 });
    const seen = wallWith(
      tool({ source: { type: 'vision' }, params: { width: 30 } }),
      model({ dimensionsMm: { x: 28, y: 210, z: 26 } }),
    );
    expect(wantedDims(seen.items[0]!, seen)).toEqual({ x: 30, y: 210, z: 26 });
  });
});

describe('resolveToolModel', () => {
  test('the class default is the pre-generated asset, shared by every item of the class', () => {
    const { d, ensured } = deps();
    const wall = wallWith(tool(), model());
    const source = resolveToolModel(wall.items[0]!, wall, d);
    expect(source?.exact).toBe(true);
    expect(source?.lod0).toBe(`/tools/assets/${screwdriver.lod0.path}`);
    expect(source?.lod1).toBe(`/tools/assets/${screwdriver.lod1.path}`);
    expect(source?.key).toBe(`tool|class:screwdriver|${screwdriver.paramHash}`);
    expect(source?.holding.hang?.kind).toBe('neck');
    expect(ensured()).toBeGreaterThan(0);
  });

  test('items that are not tools, or whose class has no generator, are left to the box stand-in', () => {
    const { d } = deps();
    const wall = wallWith(tool({ toolClass: 'usb-stick' }), model());
    expect(resolveToolModel(wall.items[0]!, wall, d)).toBeNull();
    const holder = WallItemSchema.parse({ id: 'h', kind: 'holder', bankId: 'x' });
    expect(resolveToolModel(holder, wall, d)).toBeNull();
  });

  test('a typed length draws the default until the rebuilt model arrives, then the rebuilt one', () => {
    const { d, port } = deps();
    const wall = wallWith(tool({ params: { length: screwdriver.dimsMm.y + 40 } }), model());
    const item = wall.items[0]!;
    const before = resolveToolModel(item, wall, d);
    expect(before?.exact).toBe(false);
    expect(before?.key).toBe(`tool|class:screwdriver|${screwdriver.paramHash}`);
    expect(port.posted).toHaveLength(1);
    expect(resolveToolModel(item, wall, d)?.exact).toBe(false);
    expect(port.posted).toHaveLength(1);
    port.flush();
    const after = resolveToolModel(item, wall, d);
    expect(after?.exact).toBe(true);
    expect(after?.dimsMm.y).toBeCloseTo(screwdriver.dimsMm.y + 40, 0);
    expect(after?.key).not.toBe(before?.key);
    expect(after?.lod0.startsWith('blob:')).toBe(true);
  });

  test('a size the class cannot reach ends at its limit and says it is not exact', () => {
    const { d, port } = deps();
    const wall = wallWith(tool({ params: { length: 5000 } }), model());
    resolveToolModel(wall.items[0]!, wall, d);
    port.flush();
    const built = resolveToolModel(wall.items[0]!, wall, d);
    expect(built?.exact).toBe(false);
    expect(built?.dimsMm.y).toBeGreaterThan(screwdriver.dimsMm.y);
  });

  test('typing the default size back is the pre-generated asset again', () => {
    const { d, port } = deps();
    const wall = wallWith(tool({ params: { length: screwdriver.dimsMm.y + 0.2 } }), model());
    expect(resolveToolModel(wall.items[0]!, wall, d)?.exact).toBe(true);
    expect(port.posted).toHaveLength(0);
  });

  test('a failed rebuild keeps the class default and says it failed, which is not a size limit', () => {
    const { d, port } = deps();
    port.failWith = 'worker did not load';
    const wall = wallWith(tool({ params: { length: screwdriver.dimsMm.y + 30 } }), model());
    resolveToolModel(wall.items[0]!, wall, d);
    port.flush();
    const source = resolveToolModel(wall.items[0]!, wall, d);
    expect(source).toMatchObject({ exact: false, pending: false, failed: true });
    expect(source?.key).toBe(`tool|class:screwdriver|${screwdriver.paramHash}`);
  });

  test('a library tool the loaded index does not know asks for a fresh index, once in a while', async () => {
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      return new Response('{}', { status: 503 });
    });
    const { d } = deps([screwdriver]);
    const wall = wallWith(tool(), model({ source: { type: 'library', by: 'tool:brand-new' } }));
    resolveToolModel(wall.items[0]!, wall, d);
    resolveToolModel(wall.items[0]!, wall, d);
    await settleRequests();
    restoreFetch();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/api/tools/assets/index?fresh=');
  });

  test('the measured dimensions a dragged class carries are not wishes: the pre-generated model stays', () => {
    const { d, port } = deps([hammer]);
    const measured = { ...hammer.holding.dims };
    const wall = wallWith(
      tool({ toolClass: 'hammer', params: measured }),
      model({ source: { type: 'library', by: 'gen:hammer' } }),
    );
    const source = resolveToolModel(wall.items[0]!, wall, d);
    expect(source?.exact).toBe(true);
    expect(source?.key).toBe(`tool|class:hammer|${hammer.paramHash}`);
    expect(port.posted).toHaveLength(0);
  });

  test('a library tool is never rebuilt, whatever is typed', () => {
    const { d, port } = deps([userToolEntry('mine', screwdriver)]);
    const wall = wallWith(
      tool({ params: { length: 400 } }),
      model({ source: { type: 'library', by: 'tool:mine' } }),
    );
    const source = resolveToolModel(wall.items[0]!, wall, d);
    expect(source?.entryId).toBe('tool:mine');
    expect(port.posted).toHaveLength(0);
    // Its stored model keeps its own size: what was typed is not reached and the card says so.
    expect(source?.exact).toBe(false);
  });
});
