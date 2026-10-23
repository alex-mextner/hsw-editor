import { useState } from 'react';
import { CircleAlertIcon } from 'lucide-react';
import type { BankElement } from '@hsw-editor/bank';
import { refreshBank } from '@/bank/client.ts';
import { deleteElement, elementInUseWalls, type WallUsage } from '@/bank/userClient.ts';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useI18n } from '@/i18n/index.ts';
import { userErrorMessage, type UserErrorMessage } from './userErrors.ts';

interface DeleteElementDialogProps {
  readonly element: BankElement;
  readonly onClose: () => void;
  readonly onDeleted: (element: BankElement) => void;
}

/** Confirm, and when walls still use the element say which ones and offer to delete anyway (`?force=1`). */
export function DeleteElementDialog({ element, onClose, onDeleted }: DeleteElementDialogProps) {
  const { t, tn, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [walls, setWalls] = useState<readonly WallUsage[] | null>(null);
  const [error, setError] = useState<UserErrorMessage | null>(null);

  const remove = async (force: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await deleteElement(element.id, force);
      await refreshBank({ force: true });
      onDeleted(element);
    } catch (failure) {
      const inUse = elementInUseWalls(failure);
      if (inUse !== null) setWalls(inUse);
      else setError(userErrorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      disablePointerDismissal={busy}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent data-testid="delete-element-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t('bank.user.delete.title', { name: element.name[locale] })}</DialogTitle>
          <DialogDescription>
            {walls === null ? t('bank.user.delete.body') : t('bank.user.delete.inUse')}
          </DialogDescription>
        </DialogHeader>
        {walls !== null ? (
          <ul
            data-testid="delete-element-walls"
            className="m-0 flex list-none flex-col gap-1 rounded-lg border border-border bg-card p-2 text-xs"
          >
            {walls.length === 0 ? (
              <li>{t('bank.user.delete.unknownWalls')}</li>
            ) : (
              walls.map((wall) => (
                <li key={wall.wallId} className="flex justify-between gap-2">
                  <span className="truncate font-mono">{wall.wallId}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {tn('bank.user.delete.items', wall.items)}
                  </span>
                </li>
              ))
            )}
          </ul>
        ) : null}
        {error ? (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t(error.key, { detail: error.detail })}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid={walls === null ? 'delete-element-confirm' : 'delete-element-force'}
            disabled={busy}
            onClick={() => void remove(walls !== null)}
          >
            {walls === null ? t('action.delete') : t('bank.user.delete.anyway')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
