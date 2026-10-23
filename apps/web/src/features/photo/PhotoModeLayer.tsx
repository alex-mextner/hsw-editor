import { useEffect, useState } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import type { Wall } from '@hsw-editor/core';
import { isTypingTarget } from '@/commands/typing.ts';
import { Button } from '@/components/ui/button.tsx';
import { activeRequest, useRequests } from '@/widgets/requests.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { CalibrationWizard } from '@/widgets/CalibrationWizard.tsx';
import { firstImage, importPhotoFile, importStore } from './photoImport.ts';
import { photoViewState } from '@/scene/photoView.ts';
import { finishCalibration, leavePhotoMode, photoStore, startCalibration } from '@/state/photo.ts';

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}

/** Window-level drop and paste of photo files; `dragging` is true while a file hovers over the page. */
function usePhotoIntake(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // dragenter/dragleave fire for every child element; the counter keeps the overlay stable.
    let depth = 0;
    const enter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const leave = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const drop = (event: DragEvent): void => {
      if (!carriesFiles(event)) return;
      // Another surface (the agent composer) already took this drop.
      if (event.defaultPrevented) {
        depth = 0;
        setDragging(false);
        return;
      }
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = firstImage(event.dataTransfer?.files ?? []);
      if (file) void importPhotoFile(file);
    };
    const paste = (event: ClipboardEvent): void => {
      if (isTypingTarget(event.target)) return;
      const file = firstImage(event.clipboardData?.files ?? []);
      if (!file) return;
      event.preventDefault();
      void importPhotoFile(file);
    };
    globalThis.addEventListener('dragenter', enter);
    globalThis.addEventListener('dragover', over);
    globalThis.addEventListener('dragleave', leave);
    globalThis.addEventListener('drop', drop);
    globalThis.addEventListener('paste', paste);
    return () => {
      globalThis.removeEventListener('dragenter', enter);
      globalThis.removeEventListener('dragover', over);
      globalThis.removeEventListener('dragleave', leave);
      globalThis.removeEventListener('drop', drop);
      globalThis.removeEventListener('paste', paste);
    };
  }, []);
  return dragging;
}

/** Everything photo mode puts over the viewport: file intake, import progress and the calibration wizard. */
export function PhotoModeLayer({ wall }: { readonly wall: Wall }) {
  const { t } = useI18n();
  const dragging = usePhotoIntake();
  const photo = useStore(photoStore);
  const importing = useStore(importStore);
  const target = wall.photos.find((entry) => entry.id === photo.photoId);
  // One wizard per photo: while an agent's calibration request for it is open, its card is the wizard.
  const requests = useRequests();
  const open = requests.wallId === wall.id ? activeRequest(requests) : undefined;
  const agentWizard = open?.kind === 'calibration' && open.payload.photoId === photo.photoId;

  // A photo removed from the wall (undo of the import, another tab) ends photo mode instead of showing nothing.
  const missing = photo.photoId !== null && target === undefined && importing.phase === 'idle';
  useEffect(() => {
    if (missing) leavePhotoMode();
  }, [missing]);

  // Photo mode is on but the photo cannot be drawn: say so and offer the wizard instead of an unexplained orbit view.
  const view = photoViewState(wall, photo.calibrating ? null : photo.photoId, photo.draft);
  const stuck = view.status === 'unusable' || view.status === 'uncalibrated' ? view.photo : null;

  return (
    <>
      {stuck ? (
        <div className="absolute inset-x-0 top-16 z-20 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-md flex-col gap-2 rounded-lg border border-border bg-panel/95 p-3 text-sm shadow-lg backdrop-blur">
            <strong>{t('photo.unusable.title')}</strong>
            <p className="text-xs text-muted-foreground">{t('photo.unusable.body')}</p>
            <Button size="sm" onClick={() => startCalibration(stuck.id)}>
              {t('photo.unusable.action')}
            </Button>
          </div>
        </div>
      ) : null}
      {photo.calibrating && target && !agentWizard ? (
        <section
          aria-label={t('calibration.title')}
          className="absolute inset-0 z-20 flex flex-col gap-3 overflow-y-auto bg-background p-3"
        >
          <header>
            <h2 className="text-sm font-semibold">{t('calibration.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('calibration.description')}</p>
          </header>
          <CalibrationWizard
            photoId={target.id}
            mode={target.calibration?.method === 'grid' ? 'grid' : 'two-point'}
            className="flex-1"
            onDone={finishCalibration}
            onCancel={() => (target.calibration ? finishCalibration() : leavePhotoMode())}
          />
        </section>
      ) : null}
      {importing.phase !== 'idle' ? (
        <output className="absolute bottom-12 left-1/2 z-30 flex -translate-x-1/2 flex-col gap-1.5 rounded-lg border border-border bg-panel/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
          <span className="flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            {importing.phase === 'uploading'
              ? t('photo.progress.uploading', {
                  name: importing.name,
                  percent: Math.round(importing.fraction * 100),
                })
              : t('photo.progress.processing', { name: importing.name })}
          </span>
          <progress
            className="h-1 w-full"
            aria-label={t('photo.import')}
            {...(importing.phase === 'uploading' ? { value: importing.fraction, max: 1 } : {})}
          />
        </output>
      ) : null}
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center border-2 border-dashed border-primary bg-background/80">
          <p className="flex items-center gap-2 text-sm font-medium">
            <ImagePlus className="size-5 text-primary" aria-hidden />
            {t('photo.drop.hint')}
          </p>
        </div>
      ) : null}
    </>
  );
}
