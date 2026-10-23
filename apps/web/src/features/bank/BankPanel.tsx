import { useCallback, useEffect, useRef, useState } from 'react';
import type { BankElement } from '@hsw-editor/bank';
import { bankStore, refreshBank } from '@/bank/client.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { addElementToWall, currentWall } from '@/wall/actions.ts';
import { BankBrowser } from './BankBrowser.tsx';
import { BankDetail } from './BankDetail.tsx';
import { BankEmpty, BankError, BankSkeleton, NoticeLine, type BankNotice } from './BankStates.tsx';
import { bankPanelStore, patchBankPanel } from './panelState.ts';

const NOTICE_MS = 4000;

/**
 * The element bank: search and filter the catalogue, preview elements in 3D, and put them on the wall
 * (button, double-click, Enter or drag to the viewport). Fills the left panel and scrolls inside it.
 */
export function BankPanel() {
  const { t, locale } = useI18n();
  const bank = useStore(bankStore);
  const panel = useStore(bankPanelStore);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<BankNotice | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    void refreshBank();
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const retry = useCallback(() => {
    setRetrying(true);
    void refreshBank({ force: true }).finally(() => setRetrying(false));
  }, []);

  const show = useCallback((next: BankNotice) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(next);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const add = useCallback(
    (element: BankElement) => {
      const name = element.name[locale];
      if (addElementToWall(element) !== null) {
        show({ tone: 'ok', text: t('bank.notice.added', { name }) });
      } else {
        show({
          tone: 'error',
          text: t(currentWall() ? 'bank.notice.boardFull' : 'bank.notice.noWall'),
        });
      }
    },
    [locale, show, t],
  );

  const open = useCallback((element: BankElement) => patchBankPanel({ detailId: element.id }), []);
  const back = useCallback(() => patchBankPanel({ detailId: null }), []);

  const body = (() => {
    if (bank.status === 'loading' || retrying) return <BankSkeleton />;
    if (bank.status === 'error') return <BankError message={bank.message} onRetry={retry} />;
    if (bank.index.elements.length === 0) return <BankEmpty />;
    const detail = panel.detailId === null ? undefined : bank.byId.get(panel.detailId);
    if (detail)
      return (
        <BankDetail key={detail.id} element={detail} index={bank.index} onBack={back} onAdd={add} />
      );
    return (
      <BankBrowser index={bank.index} byId={bank.byId} panel={panel} onOpen={open} onAdd={add} />
    );
  })();

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {body}
      <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />
    </div>
  );
}
