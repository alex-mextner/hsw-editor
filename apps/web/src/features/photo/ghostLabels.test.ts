import { describe, expect, test } from 'bun:test';
import { layoutLabels, type LabelRequest } from './ghostLabels.ts';

const bounds = { width: 800, height: 600, chipHeight: 24, gap: 2 };

function request(id: number, anchorX: number, anchorY: number, width = 100): LabelRequest {
  return { id, anchorX, anchorY, width };
}

function boxes(
  requests: LabelRequest[],
): { id: number; l: number; r: number; t: number; b: number }[] {
  const widthOf = new Map(requests.map((r) => [r.id, r.width]));
  return layoutLabels(requests, bounds).map((p) => {
    const w = widthOf.get(p.id) ?? 0;
    return { id: p.id, l: p.x - w / 2, r: p.x + w / 2, t: p.y, b: p.y + bounds.chipHeight };
  });
}

describe('layoutLabels', () => {
  test('a lone chip sits just above its anchor', () => {
    expect(layoutLabels([request(1, 300, 200)], bounds)).toEqual([{ id: 1, x: 300, y: 174 }]);
  });

  test('chips that would collide are pushed apart, none overlaps another', () => {
    const crowd = [
      request(1, 300, 200),
      request(2, 320, 205),
      request(3, 340, 210),
      request(4, 310, 200),
    ];
    const placed = boxes(crowd);
    for (const a of placed) {
      for (const b of placed) {
        if (a.id >= b.id) continue;
        const overlap = a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
        expect(overlap).toBe(false);
      }
    }
  });

  test('chips far apart keep their own spots', () => {
    const placed = layoutLabels([request(1, 100, 300), request(2, 600, 300)], bounds);
    expect(placed.map((p) => p.y)).toEqual([274, 274]);
  });

  test('a chip is kept inside the stage', () => {
    const [edge] = layoutLabels([request(1, 5, 5, 120)], bounds);
    expect(edge).toEqual({ id: 1, x: 60, y: 0 });
    const [right] = layoutLabels([request(2, 790, 300, 120)], bounds);
    expect(right?.x).toBe(740);
  });

  test('is deterministic and covers every request', () => {
    const crowd = [request(3, 10, 10), request(1, 10, 10), request(2, 10, 10)];
    const byId = (list: { id: number }[]) => [...list].sort((a, b) => a.id - b.id);
    expect(byId(layoutLabels(crowd, bounds))).toEqual(
      byId(layoutLabels([...crowd].reverse(), bounds)),
    );
    expect(
      layoutLabels(crowd, bounds)
        .map((p) => p.id)
        .sort(),
    ).toEqual([1, 2, 3]);
  });
});

describe('layoutLabels around reserved space', () => {
  test('a chip near the top does not land on the reserved bar', () => {
    const reserved = [{ left: 250, right: 550, top: 0, bottom: 44 }];
    const [chip] = layoutLabels([request(1, 400, 20)], { ...bounds, reserved });
    expect(chip).toBeDefined();
    if (!chip) return;
    const overlapsBar = chip.x - 50 < 550 && chip.x + 50 > 250 && chip.y < 44 && chip.y + 24 > 0;
    expect(overlapsBar).toBe(false);
  });
});

describe('layoutLabels on a crowded stage', () => {
  test('when the stage has no free row left a chip still gets a spot inside the stage', () => {
    const tight = { width: 200, height: 60, chipHeight: 24, gap: 2 };
    const crowd = Array.from({ length: 6 }, (_, index) => request(index, 100, 30, 100));
    const placed = layoutLabels(crowd, tight);
    expect(placed).toHaveLength(6);
    for (const chip of placed) {
      expect(chip.y).toBeGreaterThanOrEqual(0);
      expect(chip.y + tight.chipHeight).toBeLessThanOrEqual(tight.height);
    }
  });
});
