import { describe, expect, test } from 'bun:test';
import { FLOOR_Y_MM, restsOnFloor } from './floor.ts';
import type { WallItem } from './schema.ts';

const POSE = { x: 300, y: FLOOR_Y_MM + 5, z: 40, rotX: 90, rotY: 0, rotZ: 90 };

function tool(patch: Partial<WallItem['pose']> = {}, parentId?: string): WallItem {
  return {
    id: 't',
    kind: 'tool',
    modelRefId: 'm',
    toolClass: 'screwdriver',
    ...(parentId === undefined ? {} : { parentId }),
    pose: { ...POSE, ...patch },
    params: {},
    source: { type: 'manual' },
    locked: false,
  };
}

describe('restsOnFloor', () => {
  test('a loose tool at the floor height under the board lies on the floor', () => {
    expect(restsOnFloor(tool(), 981)).toBe(true);
  });

  test('a tool just below the board edge, one far under the floor, one hung, or off to the side is not on the floor', () => {
    expect(restsOnFloor(tool({ y: -48.7 }), 981)).toBe(false);
    expect(restsOnFloor(tool({ y: -900 }), 981)).toBe(false);
    expect(restsOnFloor(tool({}, 'h'), 981)).toBe(false);
    expect(restsOnFloor(tool({ x: 5000 }), 981)).toBe(false);
  });
});
