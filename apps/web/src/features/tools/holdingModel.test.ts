import { describe, expect, test } from 'bun:test';
import type { HoldingResponse } from './api.ts';
import { diagramModel, tickStep } from './holdingModel.ts';

const HOLDING: HoldingResponse['holding'] = {
  axis: { origin: [0, 0, 0], direction: [0, 1, 0] },
  lengthMm: 100,
  hang: { point: [0, 0, 0], kind: 'butt' },
  zones: [
    { name: 'handle', y0: 0, y1: 60 },
    { name: 'shaft', y0: 60, y1: 100 },
  ],
  profile: {
    stepMm: 25,
    samples: [
      { y: 0, w: 20, t: 20, r: 10 },
      { y: 50, w: 30, t: 28, r: 15 },
      { y: 100, w: 6, t: 6, r: 3 },
    ],
  },
  maxSection: { y: 50, w: 30, t: 28, r: 15 },
  dims: { shaftDiameter: 6 },
};

describe('tickStep', () => {
  test('uses 1, 2 or 5 times a power of ten', () => {
    expect(tickStep(100)).toBe(20);
    expect(tickStep(300)).toBe(50);
    expect(tickStep(12)).toBe(2);
  });
});

describe('diagramModel', () => {
  const layout = { width: 320, height: 160, padding: 10 };
  const model = diagramModel(HOLDING, layout);

  test('scales the axis to the drawing width', () => {
    expect(model.scale).toBeCloseTo(3, 5);
    expect(model.bands[0]).toMatchObject({ name: 'handle', x: 10, width: 180 });
    expect(model.bands[1]?.x).toBeCloseTo(190, 5);
  });

  test('puts the hang point and the widest section on the axis', () => {
    expect(model.hang).toEqual({ x: 10, kind: 'butt' });
    expect(model.widest.x).toBeCloseTo(160, 5);
    expect(model.widest.label).toBe('30 × 28');
  });

  test('both silhouettes are closed polygons inside the drawing', () => {
    for (const shape of [model.front, model.side]) {
      const points = shape.points.split(' ').map((pair) => pair.split(',').map(Number));
      expect(points.length).toBe(6);
      for (const [px, py] of points) {
        expect(px).toBeGreaterThanOrEqual(0);
        expect(px).toBeLessThanOrEqual(layout.width);
        expect(py).toBeGreaterThanOrEqual(0);
        expect(py).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  test('a tool without a hang point has no marker', () => {
    expect(diagramModel({ ...HOLDING, hang: null }, layout).hang).toBeNull();
  });
});
