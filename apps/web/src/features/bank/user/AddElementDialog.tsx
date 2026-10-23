import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { Loader2Icon } from 'lucide-react';
import type { BankElement, BankIndex, ConvertSettings, Upload } from '@hsw-editor/bank';
import { deleteUpload, reopenElement, uploadMesh } from '@/bank/userClient.ts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { useI18n } from '@/i18n/index.ts';
import { claimPreviewSlot, releasePreviewSlot } from '../previewSlot.ts';
import { DetailsStep } from './DetailsStep.tsx';
import { FileStep } from './FileStep.tsx';
import {
  formFromInput,
  formFromSuggestedName,
  meshFormatOfName,
  type FormState,
} from './formModel.ts';
import { useDaemonOffline } from './useDaemonOffline.ts';
import { userErrorMessage, type UserErrorMessage } from './userErrors.ts';

/** The dialog owns the one live WebGL preview while it is open (see previewSlot.ts). */
const DIALOG_SLOT = 'add-element';

/** What opens the dialog: a new element (optionally with a file already at hand) or an edit of a user element. */
export type AddElementRequest =
  | { readonly mode: 'add'; readonly file: File | null }
  | { readonly mode: 'edit'; readonly elementId: string };

type Stage =
  | {
      readonly step: 'file';
      readonly uploading: string | null;
      readonly error: UserErrorMessage | null;
    }
  | { readonly step: 'loading' }
  | {
      readonly step: 'details';
      readonly upload: Upload;
      readonly initial: FormState;
      readonly edit: { readonly elementId: string; readonly baseline: ConvertSettings } | null;
    }
  | { readonly step: 'failed'; readonly error: UserErrorMessage };

interface AddElementDialogProps {
  readonly request: AddElementRequest;
  readonly index: BankIndex;
  readonly onClose: () => void;
  readonly onDone: (element: BankElement, kind: 'added' | 'updated') => void;
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/** A dropped file starts uploading at once (shown from the first render); an unsupported one is refused up front. */
function initialStage(request: AddElementRequest): Stage {
  if (request.mode === 'edit') return { step: 'loading' };
  if (request.file === null) return { step: 'file', uploading: null, error: null };
  if (meshFormatOfName(request.file.name) === null) {
    return {
      step: 'file',
      uploading: null,
      error: { key: 'bank.user.error.unsupported', detail: request.file.name },
    };
  }
  return { step: 'file', uploading: request.file.name, error: null };
}

/**
 * "Add element" / "Edit element": file step, then one form with a live preview. Full screen on a phone with a
 * sticky footer. The upload it creates is removed again when the dialog is left without saving.
 */
export function AddElementDialog({ request, index, onClose, onDone }: AddElementDialogProps) {
  const { t, locale } = useI18n();
  const offline = useDaemonOffline();
  const [stage, setStage] = useState<Stage>(() => initialStage(request));
  const [running, setRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Uploads created here that nobody consumed yet; removed on cancel / unmount.
  const pending = useRef<Upload | null>(null);
  const alive = useRef(true);
  const started = useRef(false);

  useEffect(() => {
    alive.current = true;
    claimPreviewSlot(DIALOG_SLOT);
    return () => {
      alive.current = false;
      releasePreviewSlot(DIALOG_SLOT);
    };
  }, []);

  const discard = useCallback((upload: Upload | null): void => {
    if (upload) void deleteUpload(upload.id).catch(() => undefined);
  }, []);

  // Uploads the file and moves to the details step; the caller has already shown the "uploading" stage.
  const startUpload = useCallback(
    (file: File): void => {
      uploadMesh(file)
        .then((upload) => {
          if (!alive.current) {
            discard(upload);
            return;
          }
          pending.current = upload;
          setStage({
            step: 'details',
            upload,
            initial: formFromSuggestedName(upload.suggestedName, locale),
            edit: null,
          });
        })
        .catch((error: unknown) => {
          if (!alive.current) return;
          setStage({ step: 'file', uploading: null, error: userErrorMessage(error) });
        });
    },
    [discard, locale],
  );

  const handleFile = useCallback(
    (file: File): void => {
      if (meshFormatOfName(file.name) === null) {
        setStage({
          step: 'file',
          uploading: null,
          error: { key: 'bank.user.error.unsupported', detail: file.name },
        });
        return;
      }
      setStage({ step: 'file', uploading: file.name, error: null });
      startUpload(file);
    },
    [startUpload],
  );

  // Start once per mount (StrictMode runs effects twice; a second upload would be an orphan on the server).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (request.mode === 'add') {
      // The initial stage already shows the upload; only the request is started here.
      if (request.file && meshFormatOfName(request.file.name) !== null) startUpload(request.file);
      return;
    }
    reopenElement(request.elementId)
      .then(({ upload, input }) => {
        if (!alive.current) {
          discard(upload);
          return;
        }
        pending.current = upload;
        setStage({
          step: 'details',
          upload,
          initial: formFromInput(input),
          edit: { elementId: request.elementId, baseline: input.settings ?? {} },
        });
      })
      .catch((error: unknown) => {
        if (alive.current) setStage({ step: 'failed', error: userErrorMessage(error) });
      });
  }, [request, startUpload, discard]);

  // Leaving with an upload still pending (the page navigates, the panel unmounts): do not leak it.
  useEffect(
    () => () => {
      discard(pending.current);
      pending.current = null;
    },
    [discard],
  );

  const cancel = (keepUpload: boolean): void => {
    if (keepUpload) pending.current = null;
    onClose();
  };

  const changeFile = (): void => {
    discard(pending.current);
    pending.current = null;
    setStage({ step: 'file', uploading: null, error: null });
  };

  const done = (element: BankElement, kind: 'added' | 'updated'): void => {
    // The upload was deleted by the step; nothing pending any more.
    pending.current = null;
    onDone(element, kind);
  };

  const editing = request.mode === 'edit';
  return (
    <Dialog
      open
      // A click beside the dialog must not throw away a half-filled form.
      disablePointerDismissal={running || stage.step === 'details'}
      onOpenChange={(open) => {
        if (!open && !running) cancel(false);
      }}
    >
      <DialogContent
        data-testid="add-element-dialog"
        showCloseButton={!running}
        onDragOver={(event) => {
          if (stage.step === 'file' && hasFiles(event)) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          ) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          setDragging(false);
          if (stage.step !== 'file' || stage.uploading !== null || offline) return;
          const file = event.dataTransfer.files[0];
          if (!file) return;
          event.preventDefault();
          handleFile(file);
        }}
        className="top-0 left-0 flex h-dvh max-h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-clip rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-auto sm:max-h-[92dvh] sm:max-w-3xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl md:max-w-5xl"
      >
        <DialogHeader className="shrink-0 gap-1 border-b border-border px-3 py-3 pr-12 md:px-4">
          <DialogTitle>
            {editing ? t('bank.user.title.edit') : t('bank.user.title.add')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {t(editing ? 'bank.user.description.edit' : 'bank.user.description.add')}
          </DialogDescription>
        </DialogHeader>
        {stage.step === 'file' ? (
          <FileStep
            onFile={handleFile}
            uploading={stage.uploading}
            error={stage.error}
            offline={offline}
            dragging={dragging}
            onCancel={() => cancel(false)}
          />
        ) : null}
        {stage.step === 'loading' ? (
          <div className="flex min-h-48 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin text-primary" aria-hidden />
            {t('bank.user.loading')}
          </div>
        ) : null}
        {stage.step === 'failed' ? (
          <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <p role="alert" data-testid="add-element-error" className="text-sm text-destructive">
              {t(stage.error.key, { detail: stage.error.detail })}
            </p>
            <button
              type="button"
              className="text-xs text-primary underline-offset-2 hover:underline"
              onClick={() => cancel(false)}
            >
              {t('action.close')}
            </button>
          </div>
        ) : null}
        {stage.step === 'details' ? (
          <DetailsStep
            key={stage.upload.id}
            index={index}
            upload={stage.upload}
            initial={stage.initial}
            edit={stage.edit}
            offline={offline}
            onCancel={cancel}
            onChangeFile={changeFile}
            onDone={done}
            onRunningChange={setRunning}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
