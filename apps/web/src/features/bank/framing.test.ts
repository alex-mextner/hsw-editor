import { describe, expect, test } from 'bun:test';
import { frameModel, PREVIEW_FOV_DEG } from './framing.ts';

const box = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
});

describe('frameModel', () => {
  const dims = { x: 40, y: 60, z: 30 };
  const frame = frameModel(box([10, 0, 0], [50, 60, 30]), dims);

  test('centres on the bounding box, not on the origin', () => {
    expect(frame.centreMm).toEqual({ x: 30, y: 30, z: 15 });
  });

  test('camera is far enough to see the whole bounding sphere', () => {
    const distance = Math.hypot(...frame.position);
    const visibleRadius = distance * Math.sin((PREVIEW_FOV_DEG / 2) * (Math.PI / 180));
    expect(visibleRadius).toBeGreaterThan(frame.radius);
    expect(frame.near).toBeLessThan(distance - frame.radius);
    expect(frame.far).toBeGreaterThan(distance + frame.radius);
  });

  test('looks at the wall from the front: +z is out of the wall', () => {
    expect(frame.position[2]).toBeGreaterThan(0);
    expect(frame.position[1]).toBeGreaterThan(0);
  });

  test('a degenerate zero-size element still gets a usable frame', () => {
    const point = frameModel(box([0, 0, 0], [0, 0, 0]), { x: 0, y: 0, z: 0 });
    expect(Math.hypot(...point.position)).toBeGreaterThan(0);
  });
});
