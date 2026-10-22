import { describe, expect, test } from 'bun:test';
import { WallItemSchema, type WallItem } from '@hsw-editor/core';
import { bankElement, bankIndex, readyBankState } from '@/test/fixtures.ts';
import type { AssetFailure } from './assetHealth.ts';
import { itemModelIssue, missingBankItems } from './itemHealth.ts';

const GONE_ID = 'caliper-cradle-slots1-beamwidth20';

function item(id: string, bankId: string | undefined, patch: Partial<WallItem> = {}): WallItem {
  return WallItemSchema.parse({ id, kind: 'holder', bankId, ...patch });
}

const known = bankElement('known-holder');
const bank = readyBankState(bankIndex([known]));

function failure(bankId: string, state: AssetFailure['state']): AssetFailure {
  return {
    url: `/bank/assets/glb/${bankId}.glb`,
    bankId,
    kind: 'asset-missing',
    attempts: 1,
    retries: 0,
    state,
    nextRetryAt: null,
    message: 'fetch for "..." responded with 404: Not Found',
    quiet: false,
    firstFailedAt: 0,
    lastFailedAt: 0,
  };
}

describe('missingBankItems', () => {
  const items = [
    item('i-1', 'known-holder'),
    item('i-2', GONE_ID),
    item('i-3', undefined, { modelRefId: 'm-1', kind: 'tool' }),
    item('i-4', undefined, { kind: 'photo-ref', photoId: 'p-1' }),
  ];

  test('flags exactly the items whose element id is not in the loaded bank', () => {
    expect(missingBankItems(items, bank).map((entry) => entry.id)).toEqual(['i-2']);
  });

  test('is a pure read: the wall items are neither removed nor rewritten', () => {
    const snapshot = JSON.stringify(items);
    const result = missingBankItems(items, bank);
    expect(items).toHaveLength(4);
    expect(JSON.stringify(items)).toBe(snapshot);
    // The flagged entries are the very same objects the wall holds.
    expect(result[0]).toBe(items[1]);
  });

  test('flags nothing while the bank is loading or failed to load', () => {
    expect(missingBankItems(items, { status: 'loading' })).toEqual([]);
    expect(missingBankItems(items, { status: 'error', message: 'HTTP 502' })).toEqual([]);
  });
});

describe('itemModelIssue', () => {
  test('an item with an unknown bankId is a missing-from-bank issue (removed)', () => {
    expect(itemModelIssue(item('i-2', GONE_ID), bank, new Map())).toEqual({
      kind: 'missing',
      bankId: GONE_ID,
      gone: { kind: 'removed' },
    });
  });

  test('the index naming the element as unavailable carries its reason through', () => {
    const withUnavailable = readyBankState(
      bankIndex([known], {
        unavailable: [{ id: GONE_ID, name: { ru: 'Люлька', en: 'Cradle' }, reason: 'glb corrupt' }],
      }),
    );
    expect(itemModelIssue(item('i-2', GONE_ID), withUnavailable, new Map())).toEqual({
      kind: 'missing',
      bankId: GONE_ID,
      gone: { kind: 'unavailable', detail: 'glb corrupt' },
    });
  });

  test('a known element whose file failed is a failed issue with the live record', () => {
    const record = failure('known-holder', 'retrying');
    const issue = itemModelIssue(
      item('i-1', 'known-holder'),
      bank,
      new Map([[record.url, record]]),
    );
    expect(issue).toEqual({ kind: 'failed', bankId: 'known-holder', failure: record });
  });

  test('a recovered failure and healthy items raise nothing', () => {
    const record = failure('known-holder', 'recovered');
    expect(
      itemModelIssue(item('i-1', 'known-holder'), bank, new Map([[record.url, record]])),
    ).toBeNull();
    expect(itemModelIssue(item('i-1', 'known-holder'), bank, new Map())).toBeNull();
  });

  test('items without a bank element, photos, and an unready bank are never flagged', () => {
    const tool = item('i-3', undefined, { modelRefId: 'm-1', kind: 'tool' });
    expect(itemModelIssue(tool, bank, new Map())).toBeNull();
    expect(itemModelIssue(item('i-2', GONE_ID), { status: 'loading' }, new Map())).toBeNull();
  });
});
