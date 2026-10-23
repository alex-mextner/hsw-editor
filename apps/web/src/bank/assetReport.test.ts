import { beforeEach, describe, expect, test } from 'bun:test';
import type { ClientErrorEntry, ClientErrorInput } from '@/api/clientErrors.ts';
import { bankElement, bankIndex, readyBankState } from '@/test/fixtures.ts';
import { assetHealthStore, clearAssetHealth, recordFailure } from './assetHealth.ts';
import {
  assetReportInput,
  missingElementReportInput,
  reportAsset,
  reportMissingElement,
  reportOutcomeText,
  type ReportDeps,
} from './assetReport.ts';
import { bankStore } from './client.ts';
import { localeStore, t } from '@/i18n/index.ts';

const URL = '/bank/assets/glb/a47bacef44e3f4f4.glb';
const ID = 'caliper-cradle-slots1-beamwidth20';
const HASH = 'c'.repeat(64);

function deps(overrides: Partial<ReportDeps> = {}) {
  const sent: ClientErrorInput[] = [];
  const copied: string[] = [];
  const live: ReportDeps = {
    send: (input) => {
      sent.push(input);
      const entry: ClientErrorEntry = { ...input, ts: '2026-10-22T10:00:00.000Z' };
      return Promise.resolve(entry);
    },
    copy: (text) => {
      copied.push(text);
      return Promise.resolve(true);
    },
    serverIndexHash: () => Promise.resolve('d'.repeat(64)),
    ...overrides,
  };
  return { live, sent, copied };
}

beforeEach(() => {
  localeStore.set('en');
  clearAssetHealth();
  bankStore.set(readyBankState(bankIndex([bankElement('other')], { hash: HASH })));
});

function fail(): void {
  recordFailure({
    url: URL,
    bankId: ID,
    elementName: 'Caliper cradle',
    status: 404,
    kind: 'asset-missing',
    message: `fetch for "${URL}" responded with 404: Not Found`,
  });
}

describe('reportAsset', () => {
  test('sends a user-report with url, bankId, status, attempts and both index hashes', async () => {
    fail();
    const { live, sent } = deps();
    const outcome = await reportAsset(URL, live);
    expect(outcome).toEqual({ sent: true, copied: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'user-report',
      url: URL,
      bankId: ID,
      status: 404,
      detail: {
        loadErrorKind: 'asset-missing',
        attempts: 1,
        state: 'retrying',
        elementName: 'Caliper cradle',
        clientIndexHash: HASH,
        serverIndexHash: 'd'.repeat(64),
      },
    });
  });

  test('copies the very diagnostics it sent to the clipboard', async () => {
    fail();
    const { live, copied } = deps();
    await reportAsset(URL, live);
    expect(copied).toHaveLength(1);
    expect(JSON.parse(copied[0] ?? '')).toMatchObject({
      kind: 'user-report',
      url: URL,
      status: 404,
      ts: '2026-10-22T10:00:00.000Z',
    });
  });

  test('when the daemon cannot take it, the clipboard copy is still made and the outcome says so', async () => {
    fail();
    const { live, copied } = deps({ send: () => Promise.resolve(null) });
    expect(await reportAsset(URL, live)).toEqual({ sent: false, copied: true });
    expect(JSON.parse(copied[0] ?? '')).toMatchObject({ kind: 'user-report', url: URL });
  });

  test('an unknown URL reports nothing', async () => {
    const { live, sent } = deps();
    expect(await reportAsset('/nope', live)).toBeNull();
    expect(sent).toEqual([]);
  });

  test('a server hash that could not be obtained is simply left out', () => {
    fail();
    const record = assetHealthStore.get().get(URL);
    expect(record).toBeDefined();
    if (!record) return;
    expect(assetReportInput(record, bankStore.get(), undefined).detail).not.toHaveProperty(
      'serverIndexHash',
    );
  });
});

describe('reportMissingElement', () => {
  test('describes a wall item whose element is not in the bank', async () => {
    const { live, sent } = deps();
    const outcome = await reportMissingElement(ID, live);
    expect(outcome.sent).toBe(true);
    expect(sent[0]).toMatchObject({
      kind: 'user-report',
      bankId: ID,
      detail: { loadErrorKind: 'bank-missing', clientIndexHash: HASH, bankStatus: 'ready' },
    });
  });

  test('carries the pipeline reason when the index lists the element as unavailable', () => {
    const state = readyBankState(
      bankIndex([], {
        unavailable: [{ id: ID, name: { ru: 'а', en: 'a' }, reason: 'glb corrupt' }],
      }),
    );
    expect(missingElementReportInput(ID, state).detail).toMatchObject({
      unavailableReason: 'glb corrupt',
    });
  });
});

describe('reportOutcomeText', () => {
  test('tells apart sent/copied combinations', () => {
    expect(reportOutcomeText({ sent: true, copied: true }, t)).toContain('copied');
    expect(reportOutcomeText({ sent: true, copied: false }, t)).toBe('Report sent.');
    expect(reportOutcomeText({ sent: false, copied: true }, t)).toContain('did not take');
    expect(reportOutcomeText({ sent: false, copied: false }, t)).toBe('Could not send the report.');
  });
});
