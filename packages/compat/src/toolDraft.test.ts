import { describe, expect, test } from 'bun:test';
import { toolDraftOps } from './toolDraft.ts';
import { measuredDimensions } from './toolInterface.ts';

const box = { x: 28, y: 210, z: 28 };

describe('toolDraftOps', () => {
  test('a library tool: chosen model ref sourced tool:<id> and a tool item pointing at it', () => {
    const { item, ops } = toolDraftOps('screwdriver', 'Phillips', { x: 10, y: 20 }, box, {
      customToolId: 'sd-1',
      params: { shaftDiameter: 6 },
      rotZ: 90,
    });
    const [addModel, addItem] = ops;
    expect(addModel?.type).toBe('addModelRef');
    expect(addItem).toEqual({ type: 'addItem', item });
    if (addModel?.type !== 'addModelRef') throw new Error('first op is the model');
    expect(addModel.model).toMatchObject({
      label: 'Phillips',
      status: 'chosen',
      source: { type: 'library', by: 'tool:sd-1' },
      dimensionsMm: box,
      toolClass: 'screwdriver',
    });
    expect(item).toMatchObject({
      kind: 'tool',
      modelRefId: addModel.model.id,
      toolClass: 'screwdriver',
      label: 'Phillips',
      pose: { x: 10, y: 20, z: 40, rotX: 0, rotY: 0, rotZ: 90 },
      params: { shaftDiameter: 6 },
      source: { type: 'manual' },
      locked: false,
    });
  });

  test('the source names the generator class, else a plain preset', () => {
    const by = (extras: Parameters<typeof toolDraftOps>[4]) => {
      const model = toolDraftOps('pliers', 'P', { x: 0, y: 0 }, box, extras).ops[0];
      return model?.type === 'addModelRef' ? model.model.source.by : undefined;
    };
    expect(by({ generatorClass: 'pliers-combination' })).toBe('gen:pliers-combination');
    expect(by(undefined)).toBe('preset');
  });
});

describe('measuredDimensions', () => {
  test('drops the box sizes', () => {
    expect(measuredDimensions({ width: 1, length: 2, thickness: 3, shaftDiameter: 6 })).toEqual({
      shaftDiameter: 6,
    });
  });
});
