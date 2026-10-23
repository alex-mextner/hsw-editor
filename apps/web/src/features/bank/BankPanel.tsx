import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { FileUpIcon } from 'lucide-react';
import type { BankElement } from '@hsw-editor/bank';
import { bankStore, refreshBank } from '@/bank/client.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { addElementToWall, currentWall } from '@/wall/actions.ts';
import { BankBrowser } from './BankBrowser.tsx';
import { BankDetail } from './BankDetail.tsx';
import { BankEmpty, BankError, BankSkeleton, NoticeLine, type BankNotice } from './BankStates.tsx';
import { bankPanelStore, patchBankPanel } from './panelState.ts';
import { AddElementDialog, type AddElementRequest } from './user/AddElementDialog.tsx';
import { DeleteElementDialog } from './user/DeleteElementDialog.tsx';

const NOTICE_MS = 4000;

function isFileDrag(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/**
 * The element bank: search and filter the catalogue, preview elements in 3D, and put them on the wall
 * (button, double-click, Enter or drag to the viewport). Fills the left panel and scrolls inside it. A model
 * file dropped on it opens the "Add element" dialog.
 */
export function BankPanel() {
  const { t, locale } = useI18n();
  const bank = useStore(bankStore);
  const panel = useStore(bankPanelStore);
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<BankNotice | null>(null);
  const [adding, setAdding] = useState<AddElementRequest | null>(null);
  const [deleting, setDeleting] = useState<BankElement | null>(null);
  const [fileOver, setFileOver] = useState(false);
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
  const openAddDialog = useCallback(() => setAdding({ mode: 'add', file: null }), []);
  const edit = useCallback(
    (element: BankElement) => setAdding({ mode: 'edit', elementId: element.id }),
    [],
  );

  const ready = bank.status === 'ready';
  // Dialogs are portalled but their events still bubble here: a file dropped on one is theirs.
  const droppable = ready && adding === null && deleting === null;
  const dropFile = (event: DragEvent<HTMLDivElement>): void => {
    setFileOver(false);
    if (!droppable || !isFileDrag(event)) return;
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) setAdding({ mode: 'add', file });
  };

  const body = (() => {
    if (bank.status === 'loading' || retrying) return <BankSkeleton />;
    if (bank.status === 'error') return <BankError message={bank.message} onRetry={retry} />;
    if (bank.index.elements.length === 0) return <BankEmpty />;
    const detail = panel.detailId === null ? undefined : bank.byId.get(panel.detailId);
    if (detail)
      return (
        <BankDetail
          key={detail.id}
          element={detail}
          index={bank.index}
          onBack={back}
          onAdd={add}
          onEdit={edit}
          onDelete={setDeleting}
        />
      );
    return (
      <BankBrowser
        index={bank.index}
        byId={bank.byId}
        panel={panel}
        onOpen={open}
        onAdd={add}
        onAddElement={openAddDialog}
      />
    );
  })();

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-panel"
      onDragOver={(event) => {
        if (!droppable || !isFileDrag(event)) return;
        event.preventDefault();
        setFileOver(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setFileOver(false);
        }
      }}
      onDrop={dropFile}
    >
      {body}
      <NoticeLine notice={notice} onDismiss={() => setNotice(null)} />
      {fileOver ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-1 z-10 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary"
        >
          <FileUpIcon className="size-8" />
          {t('bank.user.dropHint')}
        </div>
      ) : null}
      {adding !== null && bank.status === 'ready' ? (
        <AddElementDialog
          request={adding}
          index={bank.index}
          onClose={() => setAdding(null)}
          onDone={(element, kind) => {
            setAdding(null);
            patchBankPanel({ detailId: element.id });
            show({
              tone: 'ok',
              text: t(kind === 'added' ? 'bank.user.notice.added' : 'bank.user.notice.updated', {
                name: element.name[locale],
              }),
            });
          }}
        />
      ) : null}
      {deleting !== null ? (
        <DeleteElementDialog
          element={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(element) => {
            setDeleting(null);
            patchBankPanel({ detailId: null });
            show({
              tone: 'ok',
              text: t('bank.user.notice.deleted', { name: element.name[locale] }),
            });
          }}
        />
      ) : null}
    </div>
  );
}
