import { useSyncExternalStore } from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { pwa } from '@/pwa/instance.ts';
import type { UpdateController, UpdateState } from '@/pwa/updates.ts';

const IDLE: UpdateState = { status: 'idle', dismissed: false, offlineReady: false, error: null };
const noop = (): (() => void) => () => undefined;

function useUpdateState(controller: UpdateController | null): UpdateState {
  return useSyncExternalStore(
    controller ? controller.subscribe : noop,
    controller ? controller.getSnapshot : () => IDLE,
  );
}

/**
 * "A new version is ready" (the new service worker waits until the user accepts, so an update never reloads the tab in the
 * middle of an edit) and the one-time "ready to work offline" notice after the first install.
 */
export function UpdateToast() {
  const { t } = useI18n();
  const controller = pwa.updates;
  const state = useUpdateState(controller);
  if (!controller) return null;

  if (state.status !== 'idle' && !state.dismissed) {
    return (
      <div className="pointer-events-auto fixed inset-x-0 bottom-16 z-[60] mx-auto flex w-fit max-w-md items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-lg">
        <Info className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          {state.error ? t('pwa.updateFailed', { reason: state.error }) : t('pwa.updateReady')}
        </span>
        <Button
          size="sm"
          disabled={state.status === 'applying'}
          onClick={() => void controller.accept()}
        >
          {t('pwa.updateReload')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => controller.dismiss()}>
          {t('pwa.updateLater')}
        </Button>
      </div>
    );
  }
  if (state.offlineReady) {
    return (
      <div className="pointer-events-auto fixed inset-x-0 bottom-16 z-[60] mx-auto flex w-fit items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-sm shadow-lg">
        <Info className="size-4 shrink-0 text-primary" aria-hidden />
        <span>{t('pwa.offlineReady')}</span>
        <Button size="sm" variant="ghost" onClick={() => controller.acknowledgeOfflineReady()}>
          OK
        </Button>
      </div>
    );
  }
  return null;
}
