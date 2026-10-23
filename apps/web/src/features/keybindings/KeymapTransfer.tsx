import { useRef, useState } from 'react';
import { type Command, exportUserKeymap, type UserKeymap } from '@hsw-editor/commands';
import { CopyIcon, DownloadIcon, UploadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import { notify } from '@/features/notices/notices.ts';
import { useI18n } from '@/i18n/index.ts';
import { previewImport } from './editorModel.ts';

interface KeymapTransferProps {
  readonly user: UserKeymap;
  readonly commands: readonly Command[];
  readonly onImport: (keymap: UserKeymap) => void;
}

const FILE_NAME = 'hsw-keymap.json';

function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = FILE_NAME;
  link.click();
  // Some browsers start the download asynchronously; revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Export (download and clipboard) and import (paste or file) of the user keymap JSON. */
export function KeymapTransfer({ user, commands, onImport }: KeymapTransferProps) {
  const { t, tn } = useI18n();
  const [importing, setImporting] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<readonly string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(exportUserKeymap(user));
      notify('info', t('keys.copied'));
    } catch {
      notify('error', t('keys.copyFailed'));
    }
  };

  const apply = (): void => {
    const result = previewImport(text, commands);
    if (!result.ok) {
      setError(t('keys.importFailed', { reason: result.error }));
      setWarnings([]);
      return;
    }
    onImport(result.keymap);
    setError(null);
    setWarnings(result.warnings);
    setText('');
    notify('info', tn('keys.importDone', result.overrideCount));
    if (result.warnings.length === 0) setImporting(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            download(exportUserKeymap(user));
            notify('info', t('keys.exported'));
          }}
        >
          <DownloadIcon data-icon="inline-start" />
          {t('keys.export')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          <CopyIcon data-icon="inline-start" />
          {t('keys.copy')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={importing}
          onClick={() => setImporting((value) => !value)}
        >
          <UploadIcon data-icon="inline-start" />
          {t('keys.import')}
        </Button>
      </div>
      {importing ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
          <Textarea
            value={text}
            rows={5}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={t('keys.importPlaceholder')}
            aria-label={t('keys.import')}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file === undefined) return;
                void file.text().then(setText);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileInput.current?.click()}
            >
              {t('keys.importFile')}
            </Button>
            <Button type="button" size="sm" disabled={text.trim() === ''} onClick={apply}>
              {t('keys.importApply')}
            </Button>
          </div>
          {error !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {warnings.length > 0 ? (
            <output className="block text-xs text-amber-600 dark:text-amber-400">
              <p>{t('keys.importWarnings', { count: warnings.length })}</p>
              <ul className="list-disc pl-4">
                {warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </output>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
