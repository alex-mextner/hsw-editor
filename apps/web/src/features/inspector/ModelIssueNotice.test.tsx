import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { WallItemSchema } from '@hsw-editor/core';
import { act } from 'react';
import { clearAssetHealth, recordFailure } from '@/bank/assetHealth.ts';
import { bankStore } from '@/bank/client.ts';
import { localeStore } from '@/i18n/index.ts';
import { click, mount, type Mounted } from '@/test/dom.tsx';
import { bankElement, bankIndex, readyBankState } from '@/test/fixtures.ts';
import { ItemModelNotice, ModelIssueNotice } from './ModelIssueNotice.tsx';

const GONE_ID = 'caliper-cradle-slots1-beamwidth20';
let mounted: Mounted | null = null;

beforeEach(() => {
  localeStore.set('en');
  clearAssetHealth();
  bankStore.set(readyBankState(bankIndex([bankElement('present')])));
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  bankStore.set({ status: 'loading' });
});

describe('ModelIssueNotice', () => {
  test('a missing element is named, explained, and offers Retry and Report', async () => {
    const calls: string[] = [];
    mounted = await mount(
      <ModelIssueNotice
        issue={{ kind: 'missing', bankId: GONE_ID, gone: { kind: 'removed' } }}
        checking={false}
        onRetry={() => calls.push('retry')}
        onReport={() => calls.push('report')}
      />,
    );
    const text = mounted.container.textContent ?? '';
    expect(text).toContain(`Model not found in the bank: ${GONE_ID}`);
    expect(text).toContain('The item stays on the wall');
    await click(mounted.container, /^Retry$/);
    await click(mounted.container, /^Report$/);
    expect(calls).toEqual(['retry', 'report']);
  });

  test('Retry is disabled while the bank is being rechecked', async () => {
    mounted = await mount(
      <ModelIssueNotice
        issue={{ kind: 'missing', bankId: GONE_ID, gone: { kind: 'removed' } }}
        checking
        onRetry={() => undefined}
        onReport={() => undefined}
      />,
    );
    const retry = [...mounted.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    );
    expect(retry?.disabled).toBe(true);
  });
});

describe('ItemModelNotice (store-driven)', () => {
  test('flags a selected wall item whose bankId is not in the bank', async () => {
    mounted = await mount(
      <ItemModelNotice
        item={WallItemSchema.parse({ id: 'i-2', kind: 'holder', bankId: GONE_ID })}
      />,
    );
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      `Model not found in the bank: ${GONE_ID}`,
    );
  });

  test('renders nothing for an item whose model is fine', async () => {
    mounted = await mount(
      <ItemModelNotice
        item={WallItemSchema.parse({ id: 'i-1', kind: 'holder', bankId: 'present' })}
      />,
    );
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
  });

  test('shows the load failure (with its reason) for a known element, then clears on recovery', async () => {
    const item = WallItemSchema.parse({ id: 'i-1', kind: 'holder', bankId: 'present' });
    mounted = await mount(<ItemModelNotice item={item} />);
    await act(async () => {
      recordFailure({
        url: '/bank/assets/glb/x.glb',
        bankId: 'present',
        status: 404,
        kind: 'asset-missing',
        message: 'fetch for "/bank/assets/glb/x.glb" responded with 404: Not Found',
      });
    });
    const text = mounted.container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(text).toContain('Model failed to load');
    expect(text).toContain('file not found (404)');
  });
});
