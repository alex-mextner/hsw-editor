import { useEffect, useState } from 'react';
import { CheckCircle2Icon, Loader2Icon } from 'lucide-react';
import type { Draft } from '@hsw-editor/tools/contract';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { claimPreviewSlot, releasePreviewSlot } from '@/features/bank/previewSlot.ts';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { commitDraft, deleteDraft, toolRoutes, type CommitResult, type DraftMode } from '../api.ts';
import { libraryStore, openToolDetail, refreshToolLibrary } from '../store.ts';
import { ToolThumb } from '../ToolThumb.tsx';
import { PhotoStep, VisionBanner } from './PhotoStep.tsx';
import { ReviewStep } from './ReviewStep.tsx';
import { useAnalysis, useVisionStatus } from './useAnalysis.ts';
import { AUTO_SCALE, calibrationOf, committable, type ScaleChoice } from './wizardModel.ts';

const WIZARD_SLOT = 'tool-wizard';

function ProgressView({
  done,
  total,
  message,
  uploading,
}: {
  readonly done: number | null;
  readonly total: number | null;
  readonly message: string | null;
  readonly uploading: boolean;
}) {
  const t = useI18n().t;
  return (
    <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 p-6 text-center" data-testid="wizard-progress">
      <Loader2Icon className="size-8 animate-spin text-primary" aria-hidden />
      <p className="text-sm font-medium">{uploading ? t('toolWizard.uploading') : t('toolWizard.analysing')}</p>
      {done !== null && total !== null ? (
        <p className="text-xs text-muted-foreground">{t('toolWizard.progress', { done, total })}</p>
      ) : null}
      {message === null ? null : <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}

function DoneView({
  result,
  onClose,
}: {
  readonly result: CommitResult;
  readonly onClose: () => void;
}) {
  const { t, tn, locale } = useI18n();
  return (
    <div className="flex min-h-64 flex-1 flex-col items-center gap-4 overflow-y-auto p-6" data-testid="wizard-done">
      <CheckCircle2Icon className="size-10 text-ok" aria-hidden />
      <p className="text-sm font-medium">{tn('toolWizard.done', result.tools.length)}</p>
      <ul className="m-0 flex list-none flex-wrap justify-center gap-3 p-0">
        {result.tools.map((tool) => (
          <li key={tool.id} className="w-24 text-center text-xs">
            <span className="relative mb-1 block aspect-square overflow-hidden rounded-lg border border-border">
              <ToolThumb id={`tool:${tool.id}`} url={toolRoutes.toolThumb(tool.id, tool.updatedAt)} />
            </span>
            <span className="line-clamp-2">{tool.name[locale] ?? tool.name.en ?? tool.id}</span>
          </li>
        ))}
      </ul>
      {result.skipped.length > 0 ? (
        <ul className="m-0 list-none p-0 text-xs text-warn">
          {result.skipped.map((entry) => (
            <li key={entry.key}>{t('toolWizard.done.skipped', { key: entry.key, reason: entry.reason })}</li>
          ))}
        </ul>
      ) : null}
      <Button onClick={onClose} data-testid="wizard-done-close">
        {t('toolWizard.done.close')}
      </Button>
    </div>
  );
}

/**
 * "Add from photo": drop photos, let the vision service find the tools, review and correct every detected object,
 * and save the accepted ones to the user library. Without the vision service it says so and does nothing else.
 */
export function PhotoToolsWizard({ onClose }: { readonly onClose: () => void }) {
  const { t } = useI18n();
  const library = useStore(libraryStore);
  const classes = library.status === 'ready' ? library.classes : [];
  const analysis = useAnalysis();
  const { status: vision, recheck } = useVisionStatus();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [mode, setMode] = useState<DraftMode>('multi');
  const [scale, setScale] = useState<ScaleChoice | null>(AUTO_SCALE);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  // The dialog owns the single live WebGL preview while it is open (see previewSlot.ts).
  useEffect(() => {
    claimPreviewSlot(WIZARD_SLOT);
    return () => releasePreviewSlot(WIZARD_SLOT);
  }, []);

  const { state } = analysis;
  const draft: Draft | null = state.phase === 'ready' ? state.draft : null;

  const draftId =
    state.phase === 'ready' ? state.draft.id : 'draftId' in state ? state.draftId : null;

  const close = (): void => {
    // A draft the user walks away from is not kept on the server (whatever phase it was in); a saved one is history.
    if (draftId !== null && result === null) void deleteDraft(draftId).catch(() => undefined);
    onClose();
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      const keys = committable(draft).map((object) => object.key);
      const committed = await commitDraft(draft.id, { keys, tags });
      await refreshToolLibrary(true);
      setResult(committed);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const back = (): void => {
    if (draftId !== null) void deleteDraft(draftId).catch(() => undefined);
    analysis.reset();
  };

  const body = (() => {
    if (result !== null) {
      return (
        <DoneView
          result={result}
          onClose={() => {
            const [first] = result.tools;
            onClose();
            if (first && result.tools.length === 1) openToolDetail(`tool:${first.id}`);
          }}
        />
      );
    }
    if (state.phase === 'uploading') {
      return <ProgressView done={null} total={null} message={null} uploading />;
    }
    if (state.phase === 'analysing') {
      return <ProgressView done={state.done} total={state.total} message={state.message} uploading={false} />;
    }
    if (state.phase === 'unavailable') {
      return (
        <div className="flex flex-1 flex-col gap-3 p-4" data-testid="wizard-unavailable">
          <VisionBanner vision={{ available: false, message: state.message }} onRecheck={recheck} />
          <div className="flex gap-2">
            <Button onClick={analysis.retry} data-testid="wizard-retry">
              {t('toolWizard.retry')}
            </Button>
            <Button variant="ghost" onClick={back}>
              {t('toolWizard.back')}
            </Button>
          </div>
        </div>
      );
    }
    if (draft !== null) {
      return (
        <ReviewStep
          draft={draft}
          classes={classes}
          onDraft={analysis.setDraft}
          tags={tags}
          onTags={setTags}
          saving={saving}
          saveError={saveError}
          onSave={() => void save()}
          onBack={back}
        />
      );
    }
    return (
      <PhotoStep
        files={files}
        onFiles={setFiles}
        mode={mode}
        onMode={setMode}
        scale={scale}
        onScale={setScale}
        vision={vision}
        onRecheckVision={recheck}
        busy={false}
        error={state.phase === 'failed' ? t('toolWizard.failed', { message: state.message }) : null}
        onAnalyse={() => {
          if (scale !== null) analysis.start({ files, mode, calibration: calibrationOf(scale) });
        }}
      />
    );
  })();

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent
        data-testid="photo-tools-wizard"
        className="top-0 left-0 flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-clip rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[90dvh] sm:max-h-[90dvh] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl md:max-w-6xl"
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-3 py-3 pr-12 md:px-4">
          <DialogTitle>{t('toolWizard.title')}</DialogTitle>
          <DialogDescription className="text-xs">{t('toolWizard.description')}</DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
