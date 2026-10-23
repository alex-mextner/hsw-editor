import { describe, expect, test } from 'bun:test';
import {
  compatibility,
  FIT_WEIGHT,
  physicsRating,
  rankWithPhysics,
  SCORE_BROADER_PENALTY,
} from './compatibility.ts';
import { roundTo } from './rotation.ts';
import { BANK_HOLDERS, bankHolder, TOOLS } from './fixtures/testing.ts';
import { BLOCKING_REASONS, type HolderSpec, type ToolInterface } from './types.ts';

function tool(key: string): ToolInterface {
  const found = TOOLS[key];
  if (found === undefined) throw new Error(`no tool ${key}`);
  return found;
}

describe('compatibility on real bank holders', () => {
  test('a screwdriver fits a screwdriver rail and the result explains nothing away', () => {
    const result = compatibility(tool('screwdriver'), bankHolder('refit-screwdriver-rail-3'));
    expect(result).toMatchObject({ ok: true, reasons: [], entryIndex: 0 });
    expect(result.score).toBeGreaterThan(0.6);
  });

  test('a screwdriver is refused by a tape-measure cradle with the class reason', () => {
    const result = compatibility(tool('screwdriver'), bankHolder('refit-tape-measure-cradle'));
    expect(result.ok).toBe(false);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([
      { code: 'class_mismatch', params: { toolClass: 'screwdriver', accepts: ['tape-measure'] } },
    ]);
  });

  test('a tape measure hangs on the cradle and on nothing that is not meant for it', () => {
    expect(compatibility(tool('tape-measure'), bankHolder('refit-tape-measure-cradle')).ok).toBe(
      true,
    );
    expect(compatibility(tool('tape-measure'), bankHolder('refit-screwdriver-rail-3')).ok).toBe(
      false,
    );
  });

  test('shaft diameter outside the hole range is refused with the overshoot in mm', () => {
    const tooThin = compatibility(
      tool('screwdriver'),
      bankHolder('screwdriver-rail-slots3-holediameter5'),
    );
    expect(tooThin.ok).toBe(false);
    expect(tooThin.reasons).toEqual([
      {
        code: 'dim_too_large',
        params: { key: 'shaftDiameter', valueMm: 6, maxMm: 4.6, overMm: 1.4 },
      },
    ]);
    expect(tooThin.clearances).toEqual([
      { key: 'shaftDiameter', valueMm: 6, minMm: 2, maxMm: 4.6, marginMm: -1.4 },
    ]);
    const tooWide = compatibility(
      tool('screwdriver'),
      bankHolder('screwdriver-rail-slots2-holediameter10'),
    );
    expect(tooWide.reasons).toEqual([
      { code: 'dim_too_small', params: { key: 'shaftDiameter', valueMm: 6, minMm: 7, underMm: 1 } },
    ]);
  });

  test('clearances are positive margins when the tool fits', () => {
    const result = compatibility(
      tool('screwdriver-thick'),
      bankHolder('screwdriver-rail-slots2-holediameter10'),
    );
    expect(result.ok).toBe(true);
    const [clearance] = result.clearances;
    expect(clearance?.marginMm).toBeCloseTo(1.3, 9);
  });

  test('capacity is enforced: a 3-slot rail takes three screwdrivers, not four', () => {
    const rail = bankHolder('refit-screwdriver-rail-3');
    expect(compatibility(tool('screwdriver'), rail, { occupied: 2 }).ok).toBe(true);
    const full = compatibility(tool('screwdriver'), rail, { occupied: 3 });
    expect(full.ok).toBe(false);
    expect(full.reasons).toEqual([{ code: 'slots_full', params: { capacity: 3, occupied: 3 } }]);
  });

  test('a holder without fitsTool (shelf) is not a mount', () => {
    const shelf = BANK_HOLDERS.find((spec) => spec.fitsTool.length === 0);
    if (shelf === undefined) throw new Error('seed has no shelf');
    expect(compatibility(tool('hammer'), shelf).reasons[0]?.code).toBe('not_a_mount');
  });

  test('a hole centred on the measured dimension scores higher than one it barely fits, and dims beat class-only', () => {
    const centred = compatibility(
      tool('screwdriver-thick'),
      bankHolder('screwdriver-rail-slots2-holediameter10'),
    );
    const edge: ToolInterface = { ...tool('screwdriver'), dims: { shaftDiameter: 7.05 } };
    const barely = compatibility(edge, bankHolder('screwdriver-rail-slots2-holediameter10'));
    const classOnly = compatibility(tool('screwdriver'), bankHolder('refit-screwdriver-rail-3'));
    expect(centred.score).toBeGreaterThan(barely.score);
    expect(barely.score).toBeGreaterThan(0.6);
    expect(centred.score).toBeGreaterThan(classOnly.score);
  });

  test('an unmeasured dimension does not block but costs score and is reported', () => {
    const unmeasured: ToolInterface = { ...tool('screwdriver'), dims: {} };
    const result = compatibility(unmeasured, bankHolder('screwdriver-rail-slots2-holediameter10'));
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([{ code: 'dim_unknown', params: { key: 'shaftDiameter' } }]);
  });

  test('mass above maxLoadG is refused', () => {
    const rail: HolderSpec = {
      ...bankHolder('refit-screwdriver-rail-3'),
      fitsTool: [{ toolClass: 'screwdriver', capacity: 3, maxLoadG: 150 }],
    };
    const heavy: ToolInterface = { ...tool('screwdriver'), massG: 400 };
    expect(compatibility(heavy, rail).reasons).toEqual([
      { code: 'overload', params: { massG: 400, maxLoadG: 150 } },
    ]);
    expect(compatibility({ ...heavy, massG: 100 }, rail).ok).toBe(true);
  });

  test('a holder listing the class twice is judged by its better entry', () => {
    const twin: HolderSpec = {
      ...bankHolder('refit-screwdriver-rail-3'),
      fitsTool: [
        { toolClass: 'screwdriver', dims: { shaftDiameter: { min: 2, max: 4 } } },
        { toolClass: 'screwdriver', dims: { shaftDiameter: { min: 5, max: 7 } } },
      ],
    };
    const result = compatibility(tool('screwdriver'), twin);
    expect(result.ok).toBe(true);
    expect(result.entryIndex).toBe(1);
  });
});

describe('compatibility invariants over every bank element x tool class', () => {
  const entries = Object.entries(TOOLS);

  test('ok exactly when an entry of the tool class has every dimension in range and room; score and reasons agree', () => {
    for (const holder of BANK_HOLDERS) {
      for (const [key, toolInterface] of entries) {
        const result = compatibility(toolInterface, holder);
        const oracle = holder.fitsTool.some(
          (entry) =>
            entry.toolClass === toolInterface.toolClass &&
            Object.entries(entry.dims ?? {}).every(([dim, range]) => {
              const value = toolInterface.dims[dim];
              return value === undefined || (value >= range.min && value <= range.max);
            }),
        );
        const label = `${key} on ${holder.id}`;
        expect([label, result.ok]).toEqual([label, oracle]);
        if (result.ok) {
          expect(result.score).toBeGreaterThan(0.6);
          expect(result.score).toBeLessThanOrEqual(1);
          expect(result.reasons.some((reason) => BLOCKING_REASONS.has(reason.code))).toBe(false);
          expect(result.clearances.every((c) => c.marginMm >= 0)).toBe(true);
        } else {
          expect(result.score).toBe(0);
          expect(result.reasons.some((reason) => BLOCKING_REASONS.has(reason.code))).toBe(true);
        }
      }
    }
  });

  test('every tool class finds at least one suitable bank element, and the result is deterministic', () => {
    for (const [key, toolInterface] of entries) {
      const suitable = BANK_HOLDERS.filter((holder) => compatibility(toolInterface, holder).ok);
      expect([key, suitable.length > 0]).toEqual([key, true]);
      expect(BANK_HOLDERS.map((holder) => compatibility(toolInterface, holder))).toEqual(
        BANK_HOLDERS.map((holder) => compatibility(toolInterface, holder)),
      );
    }
  });
});

describe('broader tool classes', () => {
  const chisel: ToolInterface = { ...tool('screwdriver'), toolClass: 'chisel', broader: ['knife'] };
  const entry = (toolClass: string): HolderSpec['fitsTool'][number] => ({ toolClass });
  const holder = (...classes: string[]): HolderSpec => ({
    ...bankHolder('refit-screwdriver-rail-3'),
    fitsTool: classes.map(entry),
  });

  test('a holder listing only the coarser class still takes the finer tool', () => {
    const result = compatibility(chisel, holder('knife'));
    expect(result).toMatchObject({ ok: true, entryIndex: 0 });
  });

  test('without `broader` the coarser entry is still a class mismatch', () => {
    const { broader: _omitted, ...plain } = chisel;
    expect(compatibility(plain, holder('knife')).ok).toBe(false);
  });

  test('an exact entry outranks a broader one by the documented penalty', () => {
    const exact = compatibility(chisel, holder('chisel'));
    const coarse = compatibility(chisel, holder('knife'));
    expect(exact.ok && coarse.ok).toBe(true);
    expect(roundTo(exact.score - coarse.score, 4)).toBe(SCORE_BROADER_PENALTY);
  });

  test('a holder that names the class beats a coarse-only holder even when it holds other classes too', () => {
    const coarseOnly = compatibility(chisel, holder('knife'));
    const mixed = compatibility(chisel, holder('chisel', 'scissors', 'knife'));
    expect(mixed.score).toBeGreaterThan(coarseOnly.score);
  });

  test('within one holder the exact entry wins over the broader one', () => {
    expect(compatibility(chisel, holder('knife', 'chisel')).entryIndex).toBe(1);
  });

  test('a class that is neither the tool class nor listed in `broader` stays refused', () => {
    expect(compatibility(chisel, holder('saw')).ok).toBe(false);
  });
});

describe('ranking with the physics', () => {
  const fits = compatibility(tool('screwdriver'), bankHolder('refit-screwdriver-rail-3'));
  const refused = compatibility(tool('screwdriver'), bankHolder('refit-tape-measure-cradle'));

  test('without a verdict the dimensional score is kept, a refused holder stays at zero', () => {
    expect(rankWithPhysics(fits, undefined)).toBe(fits.score);
    expect(rankWithPhysics(refused, { stability: 1, convenience: 1 })).toBe(0);
  });

  test('a holder that holds the tool beats a better fit that does not', () => {
    const tight = rankWithPhysics({ ...fits, score: 0.7 }, { stability: 1, convenience: 0.9 });
    const loose = rankWithPhysics({ ...fits, score: 0.95 }, { stability: 0.2, convenience: 0.9 });
    expect(tight).toBeGreaterThan(loose);
  });

  test('stability counts twice as much as convenience, and a missing convenience repeats the stability', () => {
    expect(physicsRating({ stability: 0.9, convenience: 0.3 })).toBe(0.7);
    expect(physicsRating({ stability: 0.6, convenience: null })).toBe(0.6);
    expect(rankWithPhysics(fits, { stability: 1, convenience: 1 })).toBe(
      roundTo(FIT_WEIGHT * fits.score + (1 - FIT_WEIGHT), 4),
    );
  });
});
