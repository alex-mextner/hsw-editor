import type { Command, Keymap, Locale } from '@hsw-editor/commands';
import { KeyboardIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { Kbd } from '@/components/Kbd.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import type { EditorRow } from './editorModel.ts';
import { KeyCapture } from './KeyCapture.tsx';

interface KeyRowProps {
  readonly row: EditorRow;
  readonly commands: readonly Command[];
  readonly keymap: Keymap;
  readonly locale: Locale;
  readonly recording: boolean;
  readonly phone: boolean;
  readonly onRecord: (commandId: string) => void;
  readonly onSave: (commandId: string, text: string) => void;
  readonly onCancel: () => void;
  readonly onRemove: (commandId: string, text: string) => void;
  readonly onReset: (commandId: string) => void;
  readonly onKeyHandled: () => void;
}

/** One command of the editor: its bindings as removable chips, plus record and reset controls. */
export function KeyRow({
  row,
  commands,
  keymap,
  locale,
  recording,
  phone,
  onRecord,
  onSave,
  onCancel,
  onRemove,
  onReset,
  onKeyHandled,
}: KeyRowProps) {
  const { t } = useI18n();
  const labelOf = (text: string): string =>
    row.bindings.find((binding) => binding.text === text)?.label ?? text;

  return (
    <li data-command={row.id} className={cn('rounded-lg px-2 py-2', recording && 'bg-accent/40')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1 basis-40">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-medium">{row.title}</span>
            {row.customised ? <Badge variant="secondary">{t('keys.custom')}</Badge> : null}
          </div>
          {row.customised && row.defaults.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('keys.defaultIs', {
                keys: row.defaults.map((binding) => binding.label).join(', '),
              })}
            </p>
          ) : null}
        </div>
        <ul className="flex flex-wrap items-center gap-1.5" aria-label={row.title}>
          {row.bindings.length === 0 ? (
            <li className="text-xs text-muted-foreground">{t('keys.unbound')}</li>
          ) : (
            row.bindings.map((binding) => (
              <li key={binding.text} className="inline-flex items-center">
                <Kbd className="ml-0 h-5 px-1.5 text-xs">{binding.label}</Kbd>
                <IconButton
                  label={t('keys.removeBinding', { keys: binding.label })}
                  size="icon-xs"
                  onClick={() => onRemove(row.id, binding.text)}
                >
                  <XIcon />
                </IconButton>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t('keys.recordFor', { command: row.title })}
            aria-pressed={recording}
            onClick={() => (recording ? onCancel() : onRecord(row.id))}
          >
            <KeyboardIcon data-icon="inline-start" />
            {row.bindings.length === 0 ? t('keys.record') : t('keys.add')}
          </Button>
          {row.customised ? (
            <IconButton
              label={t('keys.resetFor', { command: row.title })}
              size="icon-sm"
              onClick={() => onReset(row.id)}
            >
              <RotateCcwIcon />
            </IconButton>
          ) : null}
        </div>
      </div>
      {row.conflicts.map((conflict) => (
        <p
          key={`${conflict.kind}:${conflict.otherId}:${conflict.ownText}`}
          className="mt-1 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
        >
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          <span>
            <Kbd className="ml-0 mr-1">{labelOf(conflict.ownText)}</Kbd>
            {t(conflict.kind === 'duplicate' ? 'keys.conflict.duplicate' : 'keys.conflict.shadow', {
              other: conflict.otherTitle,
            })}
          </span>
        </p>
      ))}
      {recording ? (
        <KeyCapture
          commandId={row.id}
          commands={commands}
          keymap={keymap}
          locale={locale}
          typeFirst={phone}
          onSave={(text) => onSave(row.id, text)}
          onCancel={onCancel}
          onKeyHandled={onKeyHandled}
        />
      ) : null}
    </li>
  );
}
