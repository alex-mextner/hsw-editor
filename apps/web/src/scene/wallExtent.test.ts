import { describe, expect, test } from 'bun:test';
import { boardSizeMm, createEmptyWall, WallItemSchema } from '@hsw-editor/core';
import { toolAssetsStore } from '@/toolmodels/assets.ts';
import { classEntry, readyState } from '@/toolmodels/testing.ts';
import { wallExtent } from './wallExtent.ts';

const screwdriver = classEntry('screwdriver', 'screwdriver');

function wallWithTool(x: number, y: number) {
  const wall = createEmptyWall('w', 'W');
  return {
    ...wall,
    models: [
      {
        id: 'm-1',
        label: 's',
        status: 'chosen' as const,
        source: { type: 'library' as const, by: 'gen:screwdriver' },
        toolClass: 'screwdriver',
      },
    ],
    items: [
      WallItemSchema.parse({
        id: 't-1',
        kind: 'tool',
        modelRefId: 'm-1',
        toolClass: 'screwdriver',
        pose: { x, y, z: 40, rotX: 0, rotY: 0, rotZ: 0 },
      }),
    ],
  };
}

describe('wallExtent', () => {
  test('an empty wall is the board', () => {
    const wall = createEmptyWall('w', 'W');
    const { width, height } = boardSizeMm(wall.board);
    expect(wallExtent(wall, new Map())).toEqual({ x0: 0, y0: 0, x1: width, y1: height });
  });

  test('a tool sticking up past the top edge widens the frame, one inside the board does not', () => {
    toolAssetsStore.set(readyState([screwdriver]));
    const { width, height } = boardSizeMm(createEmptyWall('w', 'W').board);
    const inside = wallExtent(wallWithTool(300, 300), new Map());
    expect(inside.y1).toBe(height);
    const over = wallExtent(wallWithTool(300, height - 40), new Map());
    expect(over.y1).toBeGreaterThan(height + 100);
    expect(over.x0).toBe(0);
    expect(over.x1).toBe(width);
    toolAssetsStore.set({ status: 'idle' });
  });

  test('a far-away item cannot push the frame out by more than the cap', () => {
    toolAssetsStore.set(readyState([screwdriver]));
    const { height } = boardSizeMm(createEmptyWall('w', 'W').board);
    expect(wallExtent(wallWithTool(300, height + 5000), new Map()).y1).toBe(height + 600);
    toolAssetsStore.set({ status: 'idle' });
  });
});
