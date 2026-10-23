import { useEffect, useMemo, useRef, useState } from 'react';
import type { Command, Keymap, Locale } from '@hsw-editor/commands';
import { TriangleAlertIcon } from 'lucide-react';
import { Kbd } from '@/components/Kbd.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useI18n } from '@/i18n/index.ts';
import { candidateOf, checkCandidate, IDLE_RECORDING, recordingStep } from './editorModel.ts';
import type { RecordingState } from './editorModel.ts';

interface KeyCaptureProps {
  readonly commandId: string;
  readonly commands: readonly Command[];
  readonly keymap: Keymap;
  readonly locale: Locale;
  /** Phone width: no hardware keys, so the typed chord field takes focus. */
  readonly typeFirst: boolean;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
  /** Called for every key the recorder swallowed, so the dialog does not also react to it. */
  readonly onKeyHandled: () => void;
}

const INTERACTIVE = 'input, textarea, select, button, a, [role="button"]';

/**
 * Records a chord for one command. While it is mounted a window-level capture listener owns the
 * keyboard (the global dispatcher and the dialog's own Escape never see the keys); focused fields
 * and buttons are left alone so the typed fallback and Save/Cancel keep working.
 */
export function KeyCapture({
  commandId,
  commands,
  keymap,
  locale,
  typeFirst,
  onSave,
  onCancel,
  onKeyHandled,
}: KeyCaptureProps) {
  const { t } = useI18n();
  const { platform } = keymap;
  const [recording, setRecording] = useState<RecordingState>(IDLE_RECORDING);
  const [typed, setTyped] = useState('');
  const recordingRef = useRef(recording);
  const captureBox = useRef<HTMLOutputElement>(null);
  const typedInput = useRef<HTMLInputElement>(null);

  const candidate = candidateOf(recording, typed, platform);
  const candidateText = candidate?.ok === true ? candidate.text : null;
  const check = useMemo(
    () =>
      candidateText === null
        ? null
        : checkCandidate(keymap, commands, commandId, candidateText, locale),
    [candidateText, keymap, commands, commandId, locale],
  );
  const conflicts = check !== null && check.ok ? check.conflicts : [];
  const saveText = check?.ok === true ? candidateText : null;

  const save = (): void => {
    if (saveText !== null) onSave(saveText);
  };
  // The window listener outlives renders; it must call the latest save.
  const saveRef = useRef(save);
  const canSaveRef = useRef(saveText !== null);
  useEffect(() => {
    saveRef.current = save;
    canSaveRef.current = saveText !== null;
  });

  useEffect(() => {
    (typeFirst ? typedInput.current : captureBox.current)?.focus();
  }, [typeFirst]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest(INTERACTIVE) !== null) return;
      // A chord typed in the text field is a valid candidate too: Enter saves it from the capture box.
      const plainEnter =
        event.key === 'Enter' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.repeat &&
        !event.isComposing;
      if (plainEnter && canSaveRef.current && recordingRef.current.strokes.length === 0) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onKeyHandled();
        saveRef.current();
        return;
      }
      const step = recordingStep(recordingRef.current, event, platform);
      if (step.action === 'ignore') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onKeyHandled();
      if (step.action === 'cancel') {
        onCancel();
      } else if (step.action === 'save') {
        saveRef.current();
      } else {
        recordingRef.current = step.state;
        setRecording(step.state);
        setTyped('');
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [platform, onCancel, onKeyHandled]);

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-dashed border-border bg-muted/40 p-2">
      <output
        ref={captureBox}
        tabIndex={-1}
        aria-label={t('keys.capture')}
        className="flex min-h-9 flex-wrap items-center gap-2 rounded-md border border-input bg-background px-2 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {candidate?.ok === true ? (
          <>
            <Kbd className="ml-0 h-6 px-2 text-xs">{candidate.label}</Kbd>
            {typed.trim() === '' ? (
              <span className="text-xs text-muted-foreground">{t('keys.recordNext')}</span>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">{t('keys.recording')}</span>
        )}
      </output>
      <div className="flex flex-col gap-1">
        <Input
          value={typed}
          placeholder={t('keys.typeChord')}
          aria-label={t('keys.typeChord')}
          ref={typedInput}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={candidate !== null && !candidate.ok}
          onChange={(event) => {
            setTyped(event.target.value);
            recordingRef.current = IDLE_RECORDING;
            setRecording(IDLE_RECORDING);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onKeyHandled();
              onCancel();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              save();
            }
          }}
        />
        <p className="text-xs text-muted-foreground">{t('keys.typeChordHint')}</p>
      </div>
      {candidate !== null && !candidate.ok ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          {t('keys.invalidKey')}
        </p>
      ) : null}
      {conflicts.map((conflict) => (
        <p
          key={`${conflict.kind}:${conflict.otherId}`}
          role="alert"
          className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400"
        >
          <TriangleAlertIcon className="size-3.5 shrink-0" />
          {t(conflict.kind === 'duplicate' ? 'keys.conflict.duplicate' : 'keys.conflict.shadow', {
            other: conflict.otherTitle,
          })}
        </p>
      ))}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('keys.cancel')}
        </Button>
        <Button type="button" size="sm" disabled={saveText === null} onClick={save}>
          {conflicts.length > 0 ? t('keys.saveAnyway') : t('keys.save')}
        </Button>
      </div>
    </div>
  );
}
