import { describe, expect, test } from 'bun:test';
import {
  fitView,
  imageToScreen,
  panBy,
  pinch,
  scaleLimits,
  screenToImage,
  zoomAt,
  type ViewTransform,
} from './calibrationView.ts';

const LIMITS = { min: 0.1, max: 40 };
const VIEW: ViewTransform = { scale: 0.5, x: 30, y: -20 };

describe('zoomAt', () => {
  test('the image point under the cursor stays under the cursor', () => {
    const cursor = [210, 140] as const;
    const before = screenToImage(VIEW, cursor);
    for (const factor of [1.25, 0.8, 7]) {
      const after = zoomAt(VIEW, cursor, factor, LIMITS);
      const [u, v] = screenToImage(after, cursor);
      expect(u).toBeCloseTo(before[0], 9);
      expect(v).toBeCloseTo(before[1], 9);
    }
  });

  test('clamps the scale and still keeps the anchor fixed at the limit', () => {
    const cursor = [100, 100] as const;
    const before = screenToImage(VIEW, cursor);
    const zoomed = zoomAt(VIEW, cursor, 1000, LIMITS);
    expect(zoomed.scale).toBe(LIMITS.max);
    const [u, v] = screenToImage(zoomed, cursor);
    expect(u).toBeCloseTo(before[0], 9);
    expect(v).toBeCloseTo(before[1], 9);
    expect(zoomAt(VIEW, cursor, 1e-9, LIMITS).scale).toBe(LIMITS.min);
  });
});

describe('pinch', () => {
  test('keeps the image point between the fingers under the moving midpoint', () => {
    const from = { mid: [100, 100] as const, distance: 80 };
    const to = { mid: [130, 90] as const, distance: 160 };
    const anchor = screenToImage(VIEW, from.mid);
    const next = pinch(VIEW, from, to, LIMITS);
    expect(next.scale).toBeCloseTo(VIEW.scale * 2, 9);
    const [x, y] = imageToScreen(next, anchor);
    expect(x).toBeCloseTo(to.mid[0], 9);
    expect(y).toBeCloseTo(to.mid[1], 9);
  });
});

describe('fitView / panBy', () => {
  test('fits the whole photo inside the viewer, centred', () => {
    const view = fitView({ width: 400, height: 300 }, { width: 2000, height: 1000 }, 0);
    expect(view.scale).toBeCloseTo(0.2, 9);
    expect(view.x).toBeCloseTo(0, 9);
    expect(view.y).toBeCloseTo(50, 9);
    expect(scaleLimits({ width: 400, height: 300 }, { width: 2000, height: 1000 }).max).toBe(40);
  });

  test('panning moves screen positions by the drag delta and keeps the scale', () => {
    const moved = panBy(VIEW, 12, -7);
    expect(moved.scale).toBe(VIEW.scale);
    expect(imageToScreen(moved, [10, 10])).toEqual([
      imageToScreen(VIEW, [10, 10])[0] + 12,
      imageToScreen(VIEW, [10, 10])[1] - 7,
    ]);
  });
});
