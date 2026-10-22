import type { Translate } from '@/i18n/index.ts';
import type { AssetFailure } from './assetHealth.ts';

/** Human wording of why an asset is not shown, shared by the toast, the placeholder and the Inspector. */
export function failureReason(
  failure: Pick<AssetFailure, 'kind' | 'status' | 'gone'>,
  t: Translate,
): string {
  if (failure.gone?.kind === 'removed') return t('asset.reason.removed');
  if (failure.gone?.kind === 'unavailable') {
    return t('asset.reason.unavailable', { reason: failure.gone.detail });
  }
  switch (failure.kind) {
    case 'asset-missing':
      return t('asset.reason.missing', { status: failure.status ?? '—' });
    case 'network':
      return t('asset.reason.network');
    case 'decode':
      return t('asset.reason.decode');
    case 'unknown':
      return t('asset.reason.unknown');
  }
}

/** Name to show for a failed asset: the element's, else its bank id, else the URL's last segment. */
export function failureName(failure: Pick<AssetFailure, 'elementName' | 'bankId' | 'url'>): string {
  return failure.elementName ?? failure.bankId ?? failure.url.split('/').pop() ?? failure.url;
}

/** Text of the toast for the current state of a failure. */
export function failureToastText(failure: AssetFailure, t: Translate): string {
  const params = { name: failureName(failure), reason: failureReason(failure, t) };
  if (failure.gone) return t('asset.toast.gone', params);
  if (failure.state === 'failed') return t('asset.toast.failedManual', params);
  return t('asset.toast.failed', params);
}
