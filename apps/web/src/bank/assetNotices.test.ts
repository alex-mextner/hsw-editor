import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { dismiss, toastStore } from '@/features/notices/notices.ts';
import { localeStore, t } from '@/i18n/index.ts';
import {
  assetHealthStore,
  clearAssetHealth,
  markGone,
  markRecovered,
  markReloading,
  markRetrying,
  recordFailure,
} from './assetHealth.ts';
import { resetAssetNotices, syncAssetNotices, type AssetNoticeActions } from './assetNotices.ts';

const URL = '/bank/assets/glb/a47bacef44e3f4f4.glb';
const input = {
  url: URL,
  bankId: 'caliper-cradle-slots1-beamwidth20',
  elementName: 'Caliper cradle',
  status: 404,
  kind: 'asset-missing',
  message: '404',
} as const;
const clock = { now: () => 1000, jitter: () => 0 };

const calls: string[] = [];
const handlers: AssetNoticeActions = {
  retry: (url) => calls.push(`retry:${url}`),
  report: (url) => calls.push(`report:${url}`),
};

function sync(): void {
  syncAssetNotices(assetHealthStore.get(), handlers, t);
}

beforeEach(() => {
  localeStore.set('en');
  clearAssetHealth();
  resetAssetNotices();
  calls.length = 0;
  for (const toast of toastStore.get()) dismiss(toast.id);
});
afterEach(() => {
  for (const toast of toastStore.get()) dismiss(toast.id);
});

describe('asset notices', () => {
  test('one persistent toast per URL, with Retry and Report, however often it fails', () => {
    recordFailure(input, clock);
    sync();
    recordFailure(input, clock);
    sync();
    recordFailure({ ...input, quiet: false }, clock);
    sync();
    const toasts = toastStore.get();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('error');
    expect(toasts[0]?.actions.map((action) => action.label)).toEqual(['Retry', 'Report']);
    expect(toasts[0]?.text).toBe('Caliper cradle: file not found (404). Retrying automatically.');
  });

  test('the buttons call the retry and report handlers for that URL', () => {
    recordFailure(input, clock);
    sync();
    const [retry, report] = toastStore.get()[0]?.actions ?? [];
    retry?.run();
    report?.run();
    expect(calls).toEqual([`retry:${URL}`, `report:${URL}`]);
  });

  test('when the automatic attempts run out the same toast says so', () => {
    recordFailure(input, clock);
    sync();
    for (let n = 0; n < 6; n++) {
      markRetrying(URL);
      markReloading(URL);
      recordFailure(input, clock);
    }
    sync();
    expect(toastStore.get()).toHaveLength(1);
    expect(toastStore.get()[0]?.text).toContain('Automatic retries are used up');
  });

  test('a removed element rewrites the toast in place and drops the Retry button', () => {
    recordFailure(input, clock);
    sync();
    const id = toastStore.get()[0]?.id;
    markGone(URL, { kind: 'removed' });
    sync();
    expect(toastStore.get()).toHaveLength(1);
    expect(toastStore.get()[0]?.id).toBe(id ?? -1);
    expect(toastStore.get()[0]?.text).toBe('Caliper cradle: removed from the bank.');
    expect(toastStore.get()[0]?.actions.map((action) => action.label)).toEqual(['Report']);
  });

  test('recovery replaces the failure toast with a short success note (same slot)', () => {
    recordFailure(input, clock);
    sync();
    const id = toastStore.get()[0]?.id;
    markRecovered(URL);
    sync();
    const toasts = toastStore.get();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.id).toBe(id ?? -1);
    expect(toasts[0]).toMatchObject({ kind: 'info', text: 'Caliper cradle: loaded.', actions: [] });
  });

  test('a toast the user closed is not resurrected by later retries, but a fresh failure after recovery shows again', () => {
    recordFailure(input, clock);
    sync();
    dismiss(toastStore.get()[0]?.id ?? -1);
    recordFailure(input, clock);
    sync();
    expect(toastStore.get()).toHaveLength(0);

    markRecovered(URL);
    sync();
    recordFailure(input, clock);
    sync();
    expect(toastStore.get()).toHaveLength(1);
    expect(toastStore.get()[0]?.kind).toBe('error');
  });

  test('quiet failures (hover previews) raise no toast until a loud boundary hits the same URL', () => {
    recordFailure({ ...input, quiet: true }, clock);
    sync();
    expect(toastStore.get()).toHaveLength(0);
    recordFailure({ ...input, quiet: false }, clock);
    sync();
    expect(toastStore.get()).toHaveLength(1);
  });

  test('two failing URLs get two toasts', () => {
    recordFailure(input, clock);
    recordFailure({ ...input, url: '/bank/assets/glb/b.glb' }, clock);
    sync();
    expect(toastStore.get()).toHaveLength(2);
  });
});
