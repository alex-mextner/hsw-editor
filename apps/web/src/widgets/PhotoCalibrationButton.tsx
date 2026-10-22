import { useState } from 'react';
import { RulerIcon } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useT } from '@/i18n/index.ts';
import { CalibrationWidget } from './CalibrationWidget.tsx';

/** Opens the calibration widget for one wall photo in a dialog (photo list rows, photo inspector). */
export function PhotoCalibrationButton({ photoId }: { readonly photoId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton label={t('calibration.open')} size="icon-xs" onClick={() => setOpen(true)}>
        <RulerIcon />
      </IconButton>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('calibration.title')}</DialogTitle>
            <DialogDescription>{t('calibration.description')}</DialogDescription>
          </DialogHeader>
          <CalibrationWidget photoId={photoId} mode="two-point" onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
