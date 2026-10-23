import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ImagePlusIcon, Loader2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import type { DraftMode, VisionStatus } from '../api.ts';
import { ScaleReference } from './ScaleReference.tsx';
import {
  MAX_PHOTOS,
  takePhotos,
  type PhotoProblem,
  type ScaleChoice,
} from './wizardModel.ts';

interface PhotoStepProps {
  readonly files: readonly File[];
  readonly onFiles: (files: readonly File[]) => void;
  readonly mode: DraftMode;
  readonly onMode: (mode: DraftMode) => void;
  readonly scale: ScaleChoice | null;
  readonly onScale: (scale: ScaleChoice | null) => void;
  readonly vision: VisionStatus | null;
  readonly onRecheckVision: () => void;
  readonly busy: boolean;
  readonly onAnalyse: () => void;
  /** A failed upload or analysis of the previous attempt. */
  readonly error: string | null;
}

const MODE_ITEM = 'aria-pressed:border-primary aria-pressed:bg-primary/15';

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/** Step 1: drop the photos, say what is on them, give a scale reference, and start the analysis. */
export function PhotoStep({
  files,
  onFiles,
  mode,
  onMode,
  scale,
  onScale,
  vision,
  onRecheckVision,
  busy,
  onAnalyse,
  error,
}: PhotoStepProps) {
  const { t, tn } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [refused, setRefused] = useState<ReadonlyArray<{ name: string; problem: PhotoProblem }>>([]);
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  const take = (list: readonly File[]): void => {
    const taken = takePhotos(files, list);
    setRefused(taken.rejected.map(({ file, problem }) => ({ name: file.name, problem })));
    if (taken.accepted.length > 0) onFiles([...files, ...taken.accepted]);
  };
  const unavailable = vision !== null && !vision.available;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 md:p-4" data-testid="wizard-photos">
      {unavailable ? <VisionBanner vision={vision} onRecheck={onRecheckVision} /> : null}
      <section
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          setOver(false);
          if (!hasFiles(event)) return;
          event.preventDefault();
          take(Array.from(event.dataTransfer.files));
        }}
        className={cn(
          'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed p-5 text-center transition-colors',
          over ? 'border-primary bg-primary/10' : 'border-border',
        )}
      >
        <ImagePlusIcon className="size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{t('toolWizard.drop.title')}</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {t('toolWizard.drop.hint', { max: MAX_PHOTOS })}
        </p>
        <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
          {t('toolWizard.drop.choose')}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
          className="sr-only"
          data-testid="wizard-file-input"
          onChange={(event) => {
            take(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
        {refused.length > 0 ? (
          <ul role="alert" className="m-0 list-none p-0 text-xs text-destructive">
            {refused.map((entry) => (
              <li key={entry.name}>{t(`toolWizard.refused.${entry.problem}`, { name: entry.name })}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {files.length > 0 ? (
        <section className="grid gap-2" aria-label={t('toolWizard.photos')}>
          <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {tn('toolWizard.photos.count', files.length)}
          </h3>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-testid="wizard-photo-list">
            {files.map((file, index) => (
              <li key={`${file.name}:${file.size}:${index}`} className="relative">
                <img
                  src={urls[index]}
                  alt={file.name}
                  className="size-20 rounded-md border border-border object-cover"
                />
                <button
                  type="button"
                  aria-label={t('toolWizard.photo.remove', { name: file.name })}
                  onClick={() => onFiles(files.filter((_, at) => at !== index))}
                  className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-background shadow outline-none ring-1 ring-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t('toolWizard.mode')}
        </h3>
        <ToggleGroup
          aria-label={t('toolWizard.mode')}
          variant="outline"
          value={[mode]}
          onValueChange={(next) => {
            const [chosen] = next;
            if (chosen === 'single' || chosen === 'multi') onMode(chosen);
          }}
          className="flex-wrap"
        >
          <ToggleGroupItem value="multi" data-testid="wizard-mode-multi" className={MODE_ITEM}>
            {t('toolWizard.mode.multi')}
          </ToggleGroupItem>
          <ToggleGroupItem value="single" data-testid="wizard-mode-single" className={MODE_ITEM}>
            {t('toolWizard.mode.single')}
          </ToggleGroupItem>
        </ToggleGroup>
        <p className="text-xs text-muted-foreground">{t(`toolWizard.mode.${mode}.hint`)}</p>
      </section>

      <section className="grid gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t('toolWizard.scale')}
        </h3>
        <ScaleReference scale={scale} onChange={onScale} photoUrl={urls[0] ?? null} />
      </section>

      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        <Button
          onClick={onAnalyse}
          disabled={files.length === 0 || busy || unavailable || scale === null}
          data-testid="wizard-analyse"
        >
          {busy ? <Loader2Icon className="animate-spin" aria-hidden /> : null}
          {t('toolWizard.analyse')}
        </Button>
      </div>
    </div>
  );
}

/** Honest "vision service not available" state: the analysis needs the sidecar and never runs without it. */
export function VisionBanner({
  vision,
  onRecheck,
}: {
  readonly vision: VisionStatus | null;
  readonly onRecheck: () => void;
}) {
  const t = useI18n().t;
  return (
    <div
      role="alert"
      data-testid="vision-unavailable"
      className="flex flex-col gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlertIcon className="size-4 shrink-0 text-warn" aria-hidden />
        {t('toolWizard.vision.title')}
      </p>
      <p className="text-xs text-muted-foreground">{t('toolWizard.vision.body')}</p>
      {vision?.message === undefined ? null : (
        <p className="font-mono text-[11px] break-words text-muted-foreground">{vision.message}</p>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={onRecheck}>
          {t('toolWizard.vision.recheck')}
        </Button>
      </div>
    </div>
  );
}
