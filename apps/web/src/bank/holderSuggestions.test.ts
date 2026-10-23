import { describe, expect, test } from 'bun:test';
import type { BankElement } from '@hsw-editor/bank';
import type { ToolInterface } from '@hsw-editor/compat';
import { bankElement } from '@/test/fixtures.ts';
import { suggestHolders } from './holderSuggestions.ts';

const TOOL: ToolInterface = {
  toolClass: 'screwdriver',
  lengthMm: 200,
  hang: null,
  maxSection: { w: 30, t: 30, r: 21 },
  dims: { shaftDiameter: 6 },
};

type Fits = BankElement['fitsTool'];

const holder = (id: string, fitsTool: Fits): BankElement => bankElement(id, { fitsTool });

describe('suggestHolders', () => {
  test('keeps only holders that take the tool and ranks the better fit first', () => {
    const exact = holder('exact', [
      { toolClass: 'screwdriver', dims: { shaftDiameter: { min: 5, max: 7 } } },
    ]);
    const loose = holder('loose', [
      { toolClass: 'screwdriver', dims: { shaftDiameter: { min: 6.9, max: 12 } } },
    ]);
    const wrong = holder('wrong', [{ toolClass: 'pliers' }]);
    const none = holder('none', []);
    const ids = suggestHolders(TOOL, [wrong, loose, none, exact]).map((s) => s.element.id);
    expect(ids).toEqual(['exact']);
  });

  test('a mount whose range misses the dimension is refused, an unmeasured one only scores lower', () => {
    const tooSmall = holder('small', [
      { toolClass: 'screwdriver', dims: { shaftDiameter: { min: 8, max: 12 } } },
    ]);
    const classOnly = holder('class-only', [{ toolClass: 'screwdriver' }]);
    const ranked = suggestHolders(TOOL, [tooSmall, classOnly]);
    expect(ranked.map((s) => s.element.id)).toEqual(['class-only']);
    expect(ranked[0]?.score).toBeGreaterThan(0);
  });

  test('ties go to the holder with more capacity', () => {
    const one = holder('a-one', [{ toolClass: 'screwdriver', capacity: 1 }]);
    const many = holder('b-many', [{ toolClass: 'screwdriver', capacity: 8 }]);
    expect(suggestHolders(TOOL, [one, many]).map((s) => s.element.id)).toEqual(['b-many', 'a-one']);
  });
});
