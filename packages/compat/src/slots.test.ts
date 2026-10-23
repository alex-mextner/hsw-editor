import { describe, expect, test } from 'bun:test';
import { bankHolder, TOOLS } from './fixtures/testing.ts';
import { mountSlots, placeTool } from './slots.ts';
import type { ToolInterface } from './types.ts';

describe('placeTool grip of a finer tool class', () => {
  const holder = bankHolder('refit-screwdriver-rail-3');
  const slot = mountSlots(holder, holder.fitsTool[0] ?? null)[0];
  const pose = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0 };
  const base = TOOLS['pliers'];
  if (slot === undefined || base === undefined) throw new Error('fixture missing');

  const longNose: ToolInterface = { ...base, toolClass: 'long-nose-pliers', broader: ['pliers'] };

  test('a finer class goes in tip down like the coarse class it refines', () => {
    expect(placeTool(longNose, holder, slot, pose).workingEnd).toBe('down');
    expect(placeTool(base, holder, slot, pose).workingEnd).toBe('down');
  });

  test('without the `broader` link an unknown class stands butt first', () => {
    const { broader: _omitted, ...plain } = longNose;
    expect(placeTool(plain, holder, slot, pose).workingEnd).toBe('up');
  });
});
