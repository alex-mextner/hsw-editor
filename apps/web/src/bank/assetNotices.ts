import {
  dismiss,
  notify,
  replaceToast,
  toastStore,
  type ToastAction,
} from '@/features/notices/notices.ts';
import { t, type Translate } from '@/i18n/index.ts';
import { assetHealthStore, type AssetFailure } from './assetHealth.ts';
import { requestRetry } from './assetRecovery.ts';
import { reportAsset, reportOutcomeText } from './assetReport.ts';
import { failureName, failureToastText } from './failureView.ts';

/**
 * Keeps one toast per failing URL in step with the asset-health store: created on the first failure,
 * rewritten as the state changes (retry exhausted, element removed), replaced by a short success note
 * on recovery. A toast the user closed is not brought back until that URL recovers or fails anew.
 */

export interface AssetNoticeActions {
  readonly retry: (url: string) => void;
  readonly report: (url: string) => void;
}

const toastByUrl = new Map<string, number>();
const dismissedUrls = new Set<string>();

function actionsFor(
  url: string,
  handlers: AssetNoticeActions,
  tr: Translate,
  canRetry: boolean,
): ToastAction[] {
  const report = { label: tr('asset.action.report'), run: () => handlers.report(url) };
  return canRetry
    ? [{ label: tr('action.retry'), run: () => handlers.retry(url) }, report]
    : [report];
}

function currentText(id: number): string | undefined {
  return toastStore.get().find((toast) => toast.id === id)?.text;
}

function syncOne(failure: AssetFailure, handlers: AssetNoticeActions, tr: Translate): void {
  const existing = toastByUrl.get(failure.url);

  if (failure.state === 'recovered') {
    dismissedUrls.delete(failure.url);
    if (existing === undefined) return;
    toastByUrl.delete(failure.url);
    // Gone (user closed it): nothing to replace and nothing to announce.
    replaceToast(existing, 'info', tr('asset.toast.recovered', { name: failureName(failure) }));
    return;
  }

  if (failure.quiet || dismissedUrls.has(failure.url)) return;
  const text = failureToastText(failure, tr);
  // After the element is declared gone there is nothing left to retry, only to report.
  const actions = actionsFor(failure.url, handlers, tr, failure.gone === undefined);

  if (existing === undefined) {
    toastByUrl.set(failure.url, notify('error', text, { actions, persistent: true }));
    return;
  }
  if (currentText(existing) === text) return;
  if (!replaceToast(existing, 'error', text, { actions, persistent: true })) {
    toastByUrl.delete(failure.url);
    dismissedUrls.add(failure.url);
  }
}

const liveHandlers: AssetNoticeActions = {
  retry: requestRetry,
  report: (url) => {
    void reportAsset(url).then((outcome) => {
      if (outcome !== null) notify('info', reportOutcomeText(outcome, t));
    });
  },
};

/** The record each URL had when it was last applied; unchanged records are skipped (mass failures publish often). */
const applied = new Map<string, AssetFailure>();

/** Applies the current records to the toast stack (exported for tests; `watchAssetNotices` drives it). */
export function syncAssetNotices(
  records: ReadonlyMap<string, AssetFailure>,
  handlers: AssetNoticeActions = liveHandlers,
  tr: Translate = t,
): void {
  for (const failure of records.values()) {
    if (applied.get(failure.url) === failure) continue;
    applied.set(failure.url, failure);
    syncOne(failure, handlers, tr);
  }
  for (const url of [...applied.keys()]) if (!records.has(url)) applied.delete(url);
  for (const url of [...toastByUrl.keys()]) {
    if (!records.has(url)) {
      const id = toastByUrl.get(url);
      toastByUrl.delete(url);
      if (id !== undefined) dismiss(id);
    }
  }
}

/** Starts mirroring the store into toasts. Returns the stop function. */
export function watchAssetNotices(): () => void {
  syncAssetNotices(assetHealthStore.get());
  return assetHealthStore.subscribe(() => syncAssetNotices(assetHealthStore.get()));
}

/** Forget what was shown (tests). */
export function resetAssetNotices(): void {
  toastByUrl.clear();
  dismissedUrls.clear();
  applied.clear();
}
