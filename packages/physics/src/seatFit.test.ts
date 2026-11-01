import { describe, expect, test } from 'bun:test';
import type { Placement, ToolBody } from './body.ts';
import { analyseHangPose, toolGridAt } from './hang.ts';
import { measureSeatFit } from './seatFit.ts';
import { hangProblems } from './wall.ts';
import { IDENTITY, barTool, box, slotBlock, union } from './shapes.testkit.ts';

const at = (y: number): Placement => ({ rotation: IDENTITY, position: [0, y, 10] });
/** A 40 mm block with a 22 x 12 mm slot through it. */
const holder = slotBlock('slot', { halfX: 11, z0: 4, z1: 16, height: 40 });
const floored = slotBlock('floored', { halfX: 11, z0: 4, z1: 16, height: 40, floorMm: 4 });

/** A tool whose steps widen from 2 mm at the end to `collar` wide 20 mm up, then a 40 mm grip: a taper that catches in the slot. */
function steppedTool(collarHalfX: number, shaftLengthMm = 20): ToolBody {
  const steps = [1, 3, 5, 7, 9].map((half, k) => box([-half, k * 4, -6], [half, k * 4 + 4, 6]));
  const head = box([-collarHalfX, shaftLengthMm, -6], [collarHalfX, shaftLengthMm + 4, 6]);
  const grip = box([-6, shaftLengthMm + 4, -6], [6, shaftLengthMm + 60, 6]);
  return {
    id: 'stepped',
    mesh: union(...steps, head, grip),
    massG: 100,
    comMm: [0, shaftLengthMm + 30, 0],
  };
}

/** A short plain shaft with a wide collar resting on the rim. */
function collarTool(shaftLengthMm: number): ToolBody {
  return {
    id: 'collar',
    mesh: union(
      box([-3, 0, -3], [3, shaftLengthMm, 3]),
      box([-16, shaftLengthMm, -8], [16, shaftLengthMm + 4, 8]),
      box([-6, shaftLengthMm + 4, -6], [6, shaftLengthMm + 60, 6]),
    ),
    massG: 100,
    comMm: [0, shaftLengthMm + 30, 0],
  };
}

function fit(tool: ToolBody, y: number, body = holder): { wedgedMm: number; protrudeMm: number } {
  return measureSeatFit(
    toolGridAt(tool, { rotation: IDENTITY, position: [0, y, 10] }),
    body.grid(),
    body.bounds(),
    true,
  );
}

describe('how a tool sits in its holder', () => {
  test('a taper that catches by an edge half way down the opening is wedged and reported unstable', () => {
    // The 11.6 mm step overlaps the 11 mm opening by 0.6 mm: the end hangs 20 mm inside, open air below it.
    const tool = steppedTool(11.6);
    expect(fit(tool, 40 - 20).wedgedMm).toBeGreaterThan(15);
    const report = analyseHangPose({ tool, placement: at(20), obstacles: [holder], holder });
    expect(report.reasons.map((r) => r.code)).toContain('wedged');
    expect(report.status).toBe('unstable');
  });

  test('wedged is an error, not a warning', () => {
    const tool = steppedTool(11.6);
    const report = analyseHangPose({ tool, placement: at(20), obstacles: [holder], holder });
    const wedged = hangProblems(report).find((problem) => problem.code === 'wedged');
    expect(wedged?.severity).toBe('error');
  });

  test('a short shaft whose collar rests on the rim is seated, not wedged', () => {
    expect(fit(collarTool(20), 40 - 20).wedgedMm).toBe(0);
    expect(fit(collarTool(9), 40 - 9).wedgedMm).toBe(0);
  });

  test('a tool that rests on the floor of the slot is not wedged', () => {
    expect(fit(barTool(), 4, floored).wedgedMm).toBe(0);
  });

  test('a tool that goes through the opening and out of the holder is not wedged', () => {
    expect(fit(barTool(), -30).wedgedMm).toBe(0);
  });

  test('a tool hanging free of the holder is not wedged', () => {
    expect(fit(barTool(), 60).wedgedMm).toBe(0);
  });

  test('what reaches out below the holder is measured; a tool in the slot does not reach out', () => {
    expect(fit(barTool(), -25).protrudeMm).toBeGreaterThan(20);
    expect(fit(barTool(), 2).protrudeMm).toBe(0);
  });

  test('a tool absurdly far below the holder is measured in the time of its own length', () => {
    expect(fit(barTool('far', 20, 20, 10), -1e12).protrudeMm).toBeGreaterThan(1e11);
  });

  test('protrusion is flagged only where the holder has a limit for it', () => {
    const codes = (limit: number | undefined): string[] =>
      analyseHangPose({
        tool: barTool(),
        placement: at(-25),
        obstacles: [holder],
        holder,
        ...(limit === undefined ? {} : { options: { protrudeLimitMm: limit } }),
      }).reasons.map((r) => r.code);
    expect(codes(undefined)).not.toContain('protrudes');
    expect(codes(40)).not.toContain('protrudes');
    expect(codes(15)).toContain('protrudes');
  });
});
