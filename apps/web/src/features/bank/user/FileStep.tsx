import { useRef, type ChangeEvent } from 'react';
import { CircleAlertIcon, FileUpIcon, Loader2Icon, WifiOffIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import type { UserErrorMessage } from './userErrors.ts';

interface FileStepProps {
  readonly onFile: (file: File) => void;
  /** An upload is in flight. */
  readonly uploading: string | null;
  readonly error: UserErrorMessage | null;
  readonly offline: boolean;
  /** A file is being dragged over the dialog. */
  readonly dragging: boolean;
  readonly onCancel: () => void;
}

/** First step: a drop zone plus a file picker (a drop anywhere in the dialog works too, see the shell). */
export function FileStep({ onFile, uploading, error, offline, dragging, onCancel }: FileStepProps) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const disabled = offline || uploading !== null;

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // Reset so picking the same file again after an error still fires `change`.
    event.target.value = '';
    if (file) onFile(file);
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 md:p-4">
        {offline ? (
          <output
            data-testid="add-element-offline"
            className="flex items-center gap-1.5 rounded-lg border border-warn/40 bg-warn/10 p-2 text-xs"
          >
            <WifiOffIcon className="size-3.5 shrink-0" aria-hidden />
            {t('bank.user.offline')}
          </output>
        ) : null}
        <label
          data-testid="add-element-dropzone"
          className={cn(
            'flex min-h-48 flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border p-6 text-center transition-colors',
            disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:border-primary/60',
            dragging && !disabled && 'border-primary bg-primary/5',
          )}
        >
          {uploading !== null ? (
            <>
              <Loader2Icon className="size-8 animate-spin text-primary" aria-hidden />
              <output className="text-sm font-medium">
                {t('bank.user.file.uploading', { name: uploading })}
              </output>
            </>
          ) : (
            <>
              <FileUpIcon className="size-8 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">{t('bank.user.file.drop')}</p>
              <p className="max-w-72 text-xs text-muted-foreground">{t('bank.user.file.hint')}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={(event) => {
                  // The label would open the picker too; one open is enough.
                  event.preventDefault();
                  input.current?.click();
                }}
              >
                {t('bank.user.file.pick')}
              </Button>
            </>
          )}
          <input
            ref={input}
            type="file"
            data-testid="add-element-file-input"
            accept=".stl,.glb,.3mf"
            disabled={disabled}
            onChange={onChange}
            className="sr-only"
          />
        </label>
        {error ? (
          <p
            role="alert"
            data-testid="add-element-error"
            className="flex items-start gap-1.5 text-xs text-destructive"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t(error.key, { detail: error.detail })}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 justify-end border-t border-border bg-popover p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <Button variant="outline" className="max-sm:h-10 max-sm:w-full" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>
    </>
  );
}
