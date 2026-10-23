import { describe, expect, test } from 'bun:test';
import { createEmptyWall, type ModelRef, type Wall, WallItemSchema } from '@hsw-editor/core';
import { ModelRegen } from '@/toolmodels/regen.ts';
import type { ResolveDeps } from '@/toolmodels/resolve.ts';
import {
  classEntry,
  FakeRegenPort,
  FakeUrls,
  readyState,
  userToolEntry,
} from '@/toolmodels/testing.ts';
import { liveToolModel } from './context.ts';

const screwdriver = classEntry('screwdriver', 'screwdriver');

function model(by = 'preset'): ModelRef {
  return {
    id: 'm-1',
    label: 'Tool',
    status: 'chosen',
    source: { type: 'library', by },
    toolClass: 'screwdriver',
  };
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

function wallWith(item: ReturnType<typeof tool>, ref: ModelRef = model()): Wall {
  return { ...createEmptyWall('w-1', 'Wall'), items: [item], models: [ref] };
}

function deps(entries = [screwdriver]) {
  const port = new FakeRegenPort();
  const regen = new ModelRegen(
    () => port,
    new FakeUrls(),
    () => undefined,
  );
  const d: ResolveDeps = { state: () => readyState(entries), ensure: () => undefined, regen };
  return { d, port };
}

describe('liveToolModel', () => {
  test('a tool is judged on the model the scene draws: its light (lod 1) file under the scene key', () => {
    const { d } = deps();
    const wall = wallWith(tool());
    const source = liveToolModel(wall, wall.items[0]!, d);
    expect(source).toEqual({
      key: `tool|class:screwdriver|${screwdriver.paramHash}`,
      path: `/tools/assets/${screwdriver.lod1.path}`,
    });
  });

  test('a library tool is judged on its stored model', () => {
    const mine = userToolEntry('mine', screwdriver);
    const { d } = deps([screwdriver, mine]);
    const wall = wallWith(tool({ modelRefId: 'm-1' }), model('tool:mine'));
    const source = liveToolModel(wall, wall.items[0]!, d);
    expect(source?.key.startsWith('tool|tool:mine|')).toBe(true);
    expect(source?.path).toBe(`/tools/assets/${mine.lod1.path}`);
  });

  test('a size still being built is not judged on the class default, then on the built model', () => {
    const { d, port } = deps();
    const wall = wallWith(tool({ params: { length: screwdriver.dimsMm.y + 40 } }));
    const item = wall.items[0]!;
    expect(liveToolModel(wall, item, d)).toBeNull();
    port.flush();
    const built = liveToolModel(wall, item, d);
    expect(built).not.toBeNull();
    expect(built?.path.startsWith('blob:')).toBe(true);
    expect(built?.key).not.toBe(`tool|class:screwdriver|${screwdriver.paramHash}`);
  });

  test('a class nobody generates and an item that is no tool have no model', () => {
    const { d } = deps();
    const wall = wallWith(tool({ toolClass: 'usb-stick' }), { ...model(), toolClass: 'usb-stick' });
    expect(liveToolModel(wall, wall.items[0]!, d)).toBeNull();
    const holder = WallItemSchema.parse({ id: 'h', kind: 'holder', bankId: 'x' });
    expect(liveToolModel(wall, holder, d)).toBeNull();
  });
});
