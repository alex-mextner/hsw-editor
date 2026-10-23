import { describe, expect, test } from 'bun:test';
import { SIGNED_AXES, OrientationSchema } from '@hsw-editor/bank';
import { axisLabel, OUT_CHOICES, upChoices, withOut, withUp } from './orientation.ts';

describe('orientation pairing', () => {
  test('any of the six faces can be on the wall', () => {
    expect(OUT_CHOICES).toEqual([...SIGNED_AXES]);
    expect(OUT_CHOICES).toHaveLength(6);
  });

  test('"up" offers the four perpendicular axes', () => {
    expect(upChoices('+z')).toEqual(['+x', '-x', '+y', '-y']);
    expect(upChoices('-x')).toEqual(['+y', '-y', '+z', '-z']);
  });

  test('every offered pair is a valid orientation for the schema', () => {
    for (const out of OUT_CHOICES) {
      for (const up of upChoices(out)) {
        expect(OrientationSchema.safeParse({ out, up }).success).toBe(true);
      }
    }
  });

  test('changing "out" keeps "up" while it is still perpendicular', () => {
    expect(withOut('-z', '+y')).toEqual({ out: '-z', up: '+y' });
  });

  test('changing "out" onto the axis of "up" picks the first valid "up"', () => {
    const next = withOut('+y', '-y');
    expect(next.out).toBe('+y');
    expect(next.up).toBe('+x');
    expect(OrientationSchema.safeParse(next).success).toBe(true);
  });

  test('withUp rejects an axis parallel to out by repairing the pair', () => {
    expect(withUp('+z', '+x')).toEqual({ out: '+z', up: '+x' });
    const repaired = withUp('+z', '-z');
    expect(OrientationSchema.safeParse(repaired).success).toBe(true);
  });
});

describe('axis labels', () => {
  test('STL / 3MF are Z-up, a GLB is Y-up', () => {
    expect(axisLabel('+z', 'stl')).toEqual({ axis: '+Z', role: 'top' });
    expect(axisLabel('-z', '3mf')).toEqual({ axis: '-Z', role: 'bottom' });
    expect(axisLabel('+y', 'stl')).toEqual({ axis: '+Y', role: null });
    expect(axisLabel('+y', 'glb')).toEqual({ axis: '+Y', role: 'top' });
    expect(axisLabel('-x', 'glb')).toEqual({ axis: '-X', role: null });
  });
});
