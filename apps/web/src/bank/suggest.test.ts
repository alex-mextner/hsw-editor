import { describe, expect, test } from 'bun:test';
import type { BankElement, FitsTool } from '@hsw-editor/bank';
import { familyOf } from './suggest.ts';

interface Spec {
  readonly id: string;
  readonly fits?: readonly FitsTool[];
  readonly cells?: number;
  readonly family?: string;
  readonly label?: string;
  readonly dims?: readonly [number, number, number];
}

function element(spec: Spec): BankElement {
  const [x, y, z] = spec.dims ?? [10, 10, 10];
  return {
    id: spec.id,
    fitsTool: spec.fits ?? [],
    footprint: { cells: Array.from({ length: spec.cells ?? 1 }, () => ({ dCol: 0, dRow2: 0 })) },
    dimsMm: { x, y, z },
    ...(spec.family === undefined ? {} : { family: spec.family }),
    ...(spec.label === undefined ? {} : { variantLabel: { ru: spec.label, en: spec.label } }),
  } as unknown as BankElement;
}

describe('familyOf', () => {
  test('lists siblings ordered by numeric-aware label, then dims', () => {
    const twelve = element({ id: 'rack-12', family: 'rack', label: '12 slots' });
    const six = element({ id: 'rack-6', family: 'rack', label: '6 slots' });
    const unlabelledBig = element({ id: 'rack-x', family: 'rack', dims: [50, 10, 10] });
    const unlabelledSmall = element({ id: 'rack-y', family: 'rack', dims: [20, 10, 10] });
    const stranger = element({ id: 'other', family: 'other-family', label: '1 slot' });
    const family = familyOf(
      { elements: [unlabelledBig, twelve, stranger, six, unlabelledSmall] },
      twelve,
    );
    expect(family.map((member) => member.id)).toEqual(['rack-6', 'rack-12', 'rack-y', 'rack-x']);
  });

  test('an element without a family is alone, and a missing element is still included', () => {
    const solo = element({ id: 'solo' });
    expect(familyOf({ elements: [solo, element({ id: 'b' })] }, solo)).toEqual([solo]);
    const ghost = element({ id: 'ghost', family: 'f' });
    expect(familyOf({ elements: [element({ id: 'a', family: 'f' })] }, ghost)).toHaveLength(2);
  });
});
