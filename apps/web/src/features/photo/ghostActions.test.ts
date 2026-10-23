import { afterEach, describe, expect, test } from 'bun:test';
import type { PhotoMap } from '@hsw-editor/overlay';
import { acceptAllGhosts, acceptGhost } from './ghostActions.ts';
import {
  discardAllGhosts,
  ghostStore,
  parseToolGhosts,
  setGhosts,
  type ToolGhost,
} from './visionGhosts.ts';

afterEach(discardAllGhosts);

function ghost(id: number): ToolGhost {
  const parsed = parseToolGhosts({
    image: { w: 100, h: 100 },
    objects: [
      {
        id,
        bboxXywh: [10, 10, 20, 40],
        class: { toolClass: 'pliers', label: 'pliers', prob: 0.7 },
        confidence: 0.5,
        status: 'ok',
        dimensionsMm: { length: 180, width: 70, thickness: 25 },
      },
    ],
  });
  const first = parsed?.ghosts[0];
  if (!first) throw new Error('no ghost');
  return first;
}

const offPlane = { pxToWall: () => null } as unknown as PhotoMap;
const onPlane = {
  pxToWall: (px: readonly [number, number]) => [px[0], px[1]],
} as unknown as PhotoMap;

describe('acceptGhost', () => {
  test('a spot beyond the horizon adds nothing and keeps the ghost', () => {
    const one = ghost(1);
    setGhosts('p', [one]);
    expect(acceptGhost(one, offPlane)).toBe('off-plane');
    expect(ghostStore.get().ghosts).toHaveLength(1);
  });

  test('with no wall open nothing is added and the ghost stays for another try', () => {
    const one = ghost(2);
    setGhosts('p', [one]);
    expect(acceptGhost(one, onPlane)).toBe('no-wall');
    expect(ghostStore.get().ghosts.map((entry) => entry.id)).toEqual([2]);
  });
});

describe('acceptAllGhosts', () => {
  test('counts what was added and what was not, and leaves the failures proposed', () => {
    const ghosts = [ghost(1), ghost(2)];
    setGhosts('p', ghosts);
    expect(acceptAllGhosts(ghosts, onPlane)).toEqual({ added: 0, failed: 2 });
    expect(ghostStore.get().ghosts).toHaveLength(2);
  });
});
