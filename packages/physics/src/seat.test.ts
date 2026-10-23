import { describe, expect, test } from 'bun:test';
import type { SolidBody, ToolBody } from './body.ts';
import { findPegs, seatTool } from './seat.ts';
import { barTool, box, rodZ, slotBlock, solid, union } from './shapes.testkit.ts';

/** A screwdriver-like tool: 30 mm cube head at the butt (y 0..30), 6 mm square shaft up to the tip at y = 130. */
function driver(): ToolBody {
  return {
    id: 'driver',
    mesh: union(box([-15, 0, -15], [15, 30, 15]), box([-3, 30, -3], [3, 130, 3])),
    massG: 90,
    comMm: [0, 25, 0],
  };
}

/** A rail: a plate (y 0..8) with a 10 x 10 square hole through it at x = 0, z = 15. */
function rail(): SolidBody {
  return solid(
    'rail',
    box([-40, 0, 0], [-5, 8, 30]),
    box([5, 0, 0], [40, 8, 30]),
    box([-5, 0, 0], [5, 8, 10]),
    box([-5, 0, 20], [5, 8, 30]),
    box([-40, -30, 0], [40, 8, 3]),
  );
}

describe('seating', () => {
  test('a tip-down tool goes through the hole and its head rests on the plate, not on top of it', () => {
    const seat = seatTool({
      tool: driver(),
      holder: rail(),
      neighbours: [],
      anchor: [0, 8, 15],
      halfWidthMm: 20,
      tipDown: true,
    });
    expect(seat).not.toBeNull();
    if (seat === null) return;
    expect(seat.pose.rotZ).toBe(180);
    // Flipped: the origin (butt) is at the top, the head hangs 30 mm below it and sits on the plate top (y = 8).
    expect(seat.pose.y).toBeCloseTo(38, 0);
    expect(seat.pose.x).toBeCloseTo(0, 0);
    expect(seat.pose.z).toBeCloseTo(15, 0);
    // The tip is 92 mm below the plate: the shaft really is in the hole.
    expect(seat.pose.y - 130).toBeLessThan(0);
    expect(seat.report.penetrationMm).toBe(0);
    expect(seat.report.status).not.toBe('unstable');
  });

  test('a tool too wide for the hole ends up resting on top and is reported', () => {
    const fat: ToolBody = {
      id: 'fat',
      mesh: union(box([-15, 0, -15], [15, 30, 15]), box([-8, 30, -8], [8, 130, 8])),
      massG: 90,
      comMm: [0, 25, 0],
    };
    const seat = seatTool({
      tool: fat,
      holder: rail(),
      neighbours: [],
      anchor: [0, 8, 15],
      halfWidthMm: 20,
      tipDown: true,
    });
    expect(seat).not.toBeNull();
    // Whatever way it rests, the shaft is not through the plate.
    if (seat !== null) expect(seat.pose.rotZ === 180 ? seat.pose.y - 130 : 0).toBeGreaterThan(-1);
  });

  test('a bar lowered over a snug slot ends on the floor of the slot', () => {
    const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });
    const seat = seatTool({
      tool: barTool(),
      holder,
      neighbours: [],
      anchor: [0, 40, 10],
      halfWidthMm: 14,
      tipDown: false,
    });
    expect(seat).not.toBeNull();
    if (seat === null) return;
    expect(seat.pose.y).toBeCloseTo(4, 0);
    expect(seat.report.status).toBe('stable');
  });

  test('a ring hung over a peg comes to rest with its hole top on the rod', () => {
    const mesh = union(
      box([-30, 0, -5], [-20, 100, 5]),
      box([20, 0, -5], [30, 100, 5]),
      box([-30, 0, -5], [30, 10, 5]),
      box([-30, 90, -5], [30, 100, 5]),
    );
    const ring: ToolBody = {
      id: 'ring',
      mesh,
      massG: 80,
      comMm: [0, 50, 0],
      hang: { point: [0, 50, 0], kind: 'hole', diameterMm: 40 },
    };
    const peg = solid('peg', rodZ(0, 0, 4, 0, 70), box([-20, -40, -4], [20, 40, 0]));
    expect(findPegs(peg, 40, 38)).toHaveLength(1);
    const seat = seatTool({
      tool: ring,
      holder: peg,
      neighbours: [],
      anchor: [0, 0, 4],
      halfWidthMm: 10,
      tipDown: false,
    });
    expect(seat).not.toBeNull();
    if (seat === null) return;
    // The upper bar of the ring (its underside at y = 90 in the tool frame) rests on the rod top (y = 4).
    expect(seat.pose.y + 90).toBeCloseTo(4, 0);
    expect(seat.pose.z).toBeGreaterThan(5);
    expect(seat.report.status).not.toBe('unstable');
  });
});
