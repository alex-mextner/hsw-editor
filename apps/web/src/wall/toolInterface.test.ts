import { describe, expect, test } from 'bun:test';
import { createEmptyWall, type WallItem, WallItemSchema } from '@hsw-editor/core';
import { toolInterfaceOf } from './toolInterface.ts';

function tool(toolClass: string): WallItem {
  return WallItemSchema.parse({ kind: 'tool', toolClass, modelRefId: 'm-1' });
}

describe('toolInterfaceOf broader classes', () => {
  const wall = createEmptyWall('w', 'w');

  test('fills `broader` from the built-in vocabulary when no index vocabulary is given', () => {
    expect(toolInterfaceOf(tool('chisel'), wall)?.broader).toEqual(['knife']);
  });

  test('the loaded vocabulary wins over the built-in one', () => {
    const vocabulary = [{ id: 'chisel', broader: 'screwdriver' }];
    expect(toolInterfaceOf(tool('chisel'), wall, vocabulary)?.broader).toEqual(['screwdriver']);
  });

  test('a coarse class has no broader class', () => {
    expect(toolInterfaceOf(tool('knife'), wall)?.broader).toEqual([]);
  });
});
