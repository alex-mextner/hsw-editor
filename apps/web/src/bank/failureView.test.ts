import { beforeEach, describe, expect, test } from 'bun:test';
import { localeStore, t } from '@/i18n/index.ts';
import { failureName, failureReason } from './failureView.ts';

beforeEach(() => localeStore.set('en'));

describe('failureReason', () => {
  test('wording per failure kind', () => {
    expect(failureReason({ kind: 'asset-missing', status: 404 }, t)).toBe('file not found (404)');
    expect(failureReason({ kind: 'network' }, t)).toBe('network error');
    expect(failureReason({ kind: 'decode' }, t)).toBe('file is damaged');
    expect(failureReason({ kind: 'unknown' }, t)).toBe('could not be loaded');
  });

  test('a gone element overrides the load error', () => {
    expect(
      failureReason({ kind: 'asset-missing', status: 404, gone: { kind: 'removed' } }, t),
    ).toBe('removed from the bank');
    expect(
      failureReason(
        {
          kind: 'asset-missing',
          status: 404,
          gone: { kind: 'unavailable', detail: 'glb corrupt' },
        },
        t,
      ),
    ).toBe('unavailable: glb corrupt');
  });

  test('speaks Russian when the locale is ru', () => {
    localeStore.set('ru');
    expect(
      failureReason({ kind: 'asset-missing', status: 404, gone: { kind: 'removed' } }, t),
    ).toBe('удалён из банка');
  });
});

describe('failureName', () => {
  test('element name, else bank id, else the file name', () => {
    expect(failureName({ elementName: 'Cradle', bankId: 'b', url: '/x/y.glb' })).toBe('Cradle');
    expect(failureName({ bankId: 'b', url: '/x/y.glb' })).toBe('b');
    expect(failureName({ url: '/x/y.glb' })).toBe('y.glb');
  });
});
