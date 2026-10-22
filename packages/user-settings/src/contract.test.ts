import { describe, expect, test } from 'bun:test';
import {
  applySettingsPut,
  defaultSettingsDocument,
  isJsonWithinDepth,
  isValidNamespace,
  parseSettingsDocument,
  parseSettingsPutBody,
  SettingsContractError,
} from './contract.ts';

describe('contract', () => {
  test('namespace names', () => {
    for (const ok of ['keymap', 'a', 'my-ns_1', 'a'.repeat(32)]) {
      expect(isValidNamespace(ok)).toBe(true);
    }
    for (const bad of ['', 'Keymap', '1a', '-a', 'a b', 'a.b', 'a'.repeat(33), '__proto__']) {
      expect(isValidNamespace(bad)).toBe(false);
    }
  });

  test('depth counts a scalar as 1', () => {
    expect(isJsonWithinDepth(1, 1)).toBe(true);
    expect(isJsonWithinDepth([1], 1)).toBe(false);
    expect(isJsonWithinDepth({ a: [{ b: 1 }] }, 4)).toBe(true);
    expect(isJsonWithinDepth({ a: [{ b: 1 }] }, 3)).toBe(false);
  });

  test('rejects NaN, Infinity, undefined and class instances', () => {
    expect(isJsonWithinDepth(Number.NaN)).toBe(false);
    expect(isJsonWithinDepth(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonWithinDepth({ a: undefined })).toBe(false);
    expect(isJsonWithinDepth(new Date())).toBe(false);
  });

  test('applySettingsPut is pure and bumps rev only on change', () => {
    const base = defaultSettingsDocument();
    const at = new Date('2026-10-22T10:00:00Z');
    const one = applySettingsPut(base, { data: { a: { x: 1 } } }, at);
    expect(base.rev).toBe(0);
    expect(one).toEqual({ schema: 1, rev: 1, updatedAt: at.toISOString(), data: { a: { x: 1 } } });
    expect(applySettingsPut(one, { data: { a: { x: 1 } } }, at)).toBe(one);
    expect(applySettingsPut(one, { data: { a: null } }, at).data).toEqual({});
  });

  test('null is not a namespace value; an inherited name is not "present"', () => {
    expect(() =>
      parseSettingsDocument({
        schema: 1,
        rev: 1,
        updatedAt: '2026-10-22T10:00:00Z',
        data: { a: null },
      }),
    ).toThrow(SettingsContractError);
    const base = defaultSettingsDocument();
    expect(applySettingsPut(base, { data: { constructor: null } })).toBe(base);
  });

  test('parse helpers raise SettingsContractError', () => {
    expect(() => parseSettingsPutBody({ data: { 'No Good': 1 } })).toThrow(SettingsContractError);
    expect(() => parseSettingsDocument({ schema: 2 })).toThrow(SettingsContractError);
    expect(parseSettingsPutBody({ baseRev: 3, data: { a: null } })).toEqual({
      baseRev: 3,
      data: { a: null },
    });
  });
});
