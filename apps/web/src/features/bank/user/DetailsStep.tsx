import { useEffect, useRef, useState } from 'react';
import { CircleAlertIcon, Loader2Icon, WifiOffIcon } from 'lucide-react';
import type {
  BankElement,
  CellOffset,
  BankIndex,
  ConvertSettings,
  MeshFormat,
  Orientation,
  Upload,
} from '@hsw-editor/bank';
import { refreshBank } from '@/bank/client.ts';
import { deleteUpload, followImportJob, patchElement, startImportJob } from '@/bank/userClient.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { useI18n, type MessageKey } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { formatNumber } from '../detailModel.ts';
import { Section } from '../DetailSections.tsx';
import { MountingEditor, FootprintEditor } from './CellEditors.tsx';
import {
  clampMounting,
  paintFootprintCell,
  paintMountingCell,
  type MountingKind,
} from './cellEdit.ts';
import { FitsToolEditor } from './FitsToolEditor.tsx';
import {
  editSubmitMode,
  effectiveGeometry,
  formIssues,
  hasIssues,
  toImportInput,
  toPatch,
  type FormState,
  type SubmitMode,
} from './formModel.ts';
import { boxExtent } from './hexGrid.ts';
import { ModelPreview } from './ModelPreview.tsx';
import {
  CategorySelect,
  ConvertOptions,
  FieldRow,
  OrientationPicker,
  PartPicker,
} from './SettingsFields.tsx';
import { TagInput } from './TagInput.tsx';
import { useConversionPreview } from './useConversionPreview.ts';
import { userErrorMessage, type UserErrorMessage } from './userErrors.ts';

const PROGRESS_KEYS: Readonly<Record<string, MessageKey>> = {
  converting: 'bank.user.progress.converting',
  compressing: 'bank.user.progress.compressing',
  publishing: 'bank.user.progress.publishing',
};

const FALLBACK_ORIENT: Orientation = { out: '+z', up: '+y' };

type Submit =
  | { readonly phase: 'idle' }
  | { readonly phase: 'running'; readonly step: string | undefined }
  | { readonly phase: 'error'; readonly error: UserErrorMessage };

export interface DetailsStepProps {
  readonly index: BankIndex;
  readonly upload: Upload;
  readonly initial: FormState;
  /** Edit mode: the element being replaced and the settings it was built with. */
  readonly edit: { readonly elementId: string; readonly baseline: ConvertSettings } | null;
  readonly offline: boolean;
  /** Leave the dialog without saving; `keepUpload` while a job still reads it (the shell removes it otherwise). */
  readonly onCancel: (keepUpload: boolean) => void;
  /** Back to the file step with another file (add mode). */
  readonly onChangeFile: () => void;
  readonly onDone: (element: BankElement, kind: 'added' | 'updated') => void;
  readonly onRunningChange: (running: boolean) => void;
}

function withoutKey(settings: ConvertSettings, key: keyof ConvertSettings): ConvertSettings {
  const next: ConvertSettings = { ...settings };
  delete next[key];
  return next;
}

/** Second step: live preview pinned on top, then one scrollable form; the footer stays in view. */
export function DetailsStep({
  index,
  upload,
  initial,
  edit,
  offline,
  onCancel,
  onChangeFile,
  onDone,
  onRunningChange,
}: DetailsStepProps) {
  const { t, locale } = useI18n();
  const [form, setForm] = useState<FormState>(initial);
  const [submit, setSubmit] = useState<Submit>({ phase: 'idle' });
  const preview = useConversionPreview(upload.id, form.settings, offline);
  const { conversion } = preview;
  const follow = useRef<AbortController | null>(null);
  useEffect(() => () => follow.current?.abort(), []);

  const running = submit.phase === 'running';
  const locked = running;
  const geometry = effectiveGeometry(form, conversion);
  // the whole model stays inside the cell editors' window, so cells do not rescale under the pointer
  const editorExtent = [
    ...geometry.footprint,
    ...(conversion?.footprint ?? []),
    ...(conversion ? boxExtent(conversion.bboxMm) : []),
  ];
  const issues = formIssues(form, geometry);
  const mode: SubmitMode = edit === null ? 'import' : editSubmitMode(edit.baseline, form.settings);
  const format: MeshFormat = upload.format;

  const patchForm = (patch: Partial<FormState>): void =>
    setForm((current) => ({ ...current, ...patch }));
  const patchSettings = (patch: ConvertSettings): void =>
    setForm((current) => ({ ...current, settings: { ...current.settings, ...patch } }));

  // Detected cells feed the pickers until the user edits them; functional updates because a drag paints
  // many cells between two renders.
  const paintFootprint = (cell: CellOffset, on: boolean): void =>
    setForm((current) => {
      const now = effectiveGeometry(current, conversion);
      const next = paintFootprintCell(
        { footprint: now.footprint, mounting: now.mountingCells },
        cell,
        on,
      );
      return { ...current, footprint: next.footprint, mountingCells: next.mounting };
    });
  const paintPeg = (cell: CellOffset, on: boolean): void =>
    setForm((current) => {
      const now = effectiveGeometry(current, conversion);
      const next = paintMountingCell(
        { footprint: now.footprint, mounting: now.mountingCells },
        cell,
        on,
      );
      return { ...current, mountingCells: next.mounting };
    });
  const setKind = (kind: MountingKind): void =>
    setForm((current) => {
      const now = effectiveGeometry(current, conversion);
      return {
        ...current,
        mountingKind: kind,
        mountingCells: clampMounting(now.footprint, now.mountingCells),
      };
    });

  const part = upload.parts.find(
    (candidate) =>
      candidate.partId ===
      (form.settings.partId ?? conversion?.settings.partId ?? upload.defaultPartId),
  );
  const orient: Orientation =
    form.settings.orient ??
    conversion?.settings.orient ??
    part?.guess ??
    upload.parts[0]?.guess ??
    FALLBACK_ORIENT;
  const partValue = form.settings.partId ?? conversion?.settings.partId ?? upload.defaultPartId;

  const submitNow = async (): Promise<void> => {
    if (running || offline || hasIssues(issues)) return;
    const controller = new AbortController();
    follow.current = controller;
    setSubmit({ phase: 'running', step: undefined });
    onRunningChange(true);
    try {
      let element: BankElement;
      if (edit !== null && mode === 'patch') {
        element = await patchElement(edit.elementId, toPatch(form, geometry));
      } else {
        const input = toImportInput(form, geometry, {
          uploadId: upload.id,
          ...(edit === null ? {} : { replaceId: edit.elementId }),
        });
        const jobId = await startImportJob(input);
        const outcome = await followImportJob(
          jobId,
          (progress) => setSubmit({ phase: 'running', step: progress?.message }),
          controller.signal,
        );
        if (outcome.status === 'cancelled') {
          // our own abort (Stop waiting) needs no message; a job cancelled elsewhere must not leave the form locked
          if (!controller.signal.aborted)
            setSubmit({
              phase: 'error',
              error: { key: 'bank.user.error.jobFailed', detail: 'cancelled' },
            });
          return;
        }
        if (outcome.status === 'failed') {
          setSubmit({
            phase: 'error',
            error: { key: 'bank.user.error.jobFailed', detail: outcome.message ?? '' },
          });
          return;
        }
        element = outcome.element;
      }
      // Best effort: the server may already have consumed or expired the upload.
      void deleteUpload(upload.id).catch(() => undefined);
      await refreshBank({ force: true });
      onDone(element, edit === null ? 'added' : 'updated');
    } catch (error) {
      setSubmit({ phase: 'error', error: userErrorMessage(error) });
    } finally {
      onRunningChange(false);
    }
  };

  const problems: MessageKey[] = [];
  if (issues.name) problems.push('bank.user.problem.name');
  if (issues.category) problems.push('bank.user.problem.category');
  if (issues.mounting) problems.push('bank.user.mounting.noPegs');
  if (issues.fits) problems.push('bank.user.problem.fits');

  const dims = conversion?.dimsMm;
  const stepKey = submit.phase === 'running' ? PROGRESS_KEYS[submit.step ?? ''] : undefined;

  return (
    <>
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        data-testid="add-element-body"
      >
        <div className="md:grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:gap-4 md:p-4">
          <div className="sticky top-0 z-10 border-b border-border bg-popover md:self-start md:rounded-lg md:border">
            <div
              data-testid="add-element-preview"
              className="relative h-44 w-full bg-viewport sm:h-56 md:h-72"
            >
              {conversion ? (
                <ModelPreview
                  conversion={conversion}
                  footprint={geometry.footprint}
                  pegs={geometry.mountingKind === 'none' ? [] : geometry.mountingCells}
                />
              ) : null}
              {preview.busy ? (
                <output
                  className={cn(
                    'absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted-foreground',
                    conversion ? 'pointer-events-none items-start justify-end p-2' : '',
                  )}
                >
                  <Loader2Icon className="size-4 animate-spin text-primary" aria-hidden />
                  {t('bank.user.preview.busy')}
                </output>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[11px] text-muted-foreground">
              {dims ? (
                <span className="tabular-nums">
                  {t('bank.detail.dimsValue', {
                    x: formatNumber(dims.x, locale),
                    y: formatNumber(dims.y, locale),
                    z: formatNumber(dims.z, locale),
                  })}
                </span>
              ) : null}
              {conversion ? (
                <>
                  <span
                    data-testid="add-element-watertight"
                    className={conversion.watertight ? 'text-ok' : 'text-warn'}
                  >
                    {t(conversion.watertight ? 'bank.user.watertight' : 'bank.user.notWatertight')}
                  </span>
                  {conversion.repaired ? (
                    <span data-testid="add-element-repaired" className="text-ok">
                      {t('bank.user.repaired')}
                    </span>
                  ) : null}
                </>
              ) : null}
              {preview.error ? (
                <span role="alert" className="flex items-center gap-1.5 text-destructive">
                  <CircleAlertIcon className="size-3 shrink-0" aria-hidden />
                  {t(preview.error.key, { detail: preview.error.detail })}
                  <Button variant="ghost" size="xs" onClick={preview.retry}>
                    {t('action.retry')}
                  </Button>
                </span>
              ) : null}
            </div>
          </div>

          <form
            className="flex flex-col gap-5 p-3 md:p-0"
            onSubmit={(event) => {
              event.preventDefault();
              void submitNow();
            }}
          >
            {conversion && conversion.warnings.length > 0 ? (
              <ul
                data-testid="add-element-warnings"
                className="m-0 flex list-none flex-col gap-1 rounded-lg border border-warn/40 bg-warn/10 p-2 text-xs"
              >
                {conversion.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}

            <Section title={t('bank.user.section.name')}>
              <FieldRow label={t('bank.user.name.ru')} htmlFor="add-element-name-ru">
                <Input
                  id="add-element-name-ru"
                  data-testid="add-element-name-ru"
                  value={form.nameRu}
                  maxLength={120}
                  disabled={locked}
                  aria-invalid={issues.name}
                  onChange={(event) => patchForm({ nameRu: event.target.value })}
                />
              </FieldRow>
              <FieldRow
                label={t('bank.user.name.en')}
                htmlFor="add-element-name-en"
                hint={t('bank.user.name.hint')}
              >
                <Input
                  id="add-element-name-en"
                  data-testid="add-element-name-en"
                  value={form.nameEn}
                  maxLength={120}
                  disabled={locked}
                  aria-invalid={issues.name}
                  onChange={(event) => patchForm({ nameEn: event.target.value })}
                />
              </FieldRow>
              <FieldRow label={t('bank.user.category')}>
                <CategorySelect
                  categories={index.categories}
                  value={form.category}
                  disabled={locked}
                  invalid={issues.category}
                  onChange={(category) => patchForm({ category })}
                />
              </FieldRow>
              <FieldRow label={t('bank.user.tags.ru')}>
                <TagInput
                  tags={form.tagsRu}
                  label={t('bank.user.tags.ru')}
                  testId="add-element-tags-ru"
                  disabled={locked}
                  onChange={(tagsRu) => patchForm({ tagsRu })}
                />
              </FieldRow>
              <FieldRow label={t('bank.user.tags.en')}>
                <TagInput
                  tags={form.tagsEn}
                  label={t('bank.user.tags.en')}
                  testId="add-element-tags-en"
                  disabled={locked}
                  onChange={(tagsEn) => patchForm({ tagsEn })}
                />
              </FieldRow>
            </Section>

            <Section title={t('bank.user.section.model')}>
              {upload.parts.length > 1 ? (
                <FieldRow label={t('bank.user.part.label')}>
                  <PartPicker
                    parts={upload.parts}
                    value={partValue}
                    disabled={locked}
                    onChange={(partId) => patchSettings({ partId })}
                  />
                </FieldRow>
              ) : null}
              <OrientationPicker
                format={format}
                orient={orient}
                chosen={form.settings.orient !== undefined}
                disabled={locked}
                onChange={(next) =>
                  setForm((current) => ({
                    ...current,
                    settings:
                      next === null
                        ? withoutKey(current.settings, 'orient')
                        : { ...current.settings, orient: next },
                  }))
                }
              />
              <ConvertOptions
                anchor={form.settings.anchor ?? conversion?.settings.anchor ?? 'back-bbox'}
                unit={form.settings.unit ?? conversion?.settings.unit ?? 'auto'}
                repair={form.settings.repair ?? conversion?.settings.repair ?? true}
                disabled={locked}
                onAnchor={(anchor) => patchSettings({ anchor })}
                onUnit={(unit) => patchSettings({ unit })}
                onRepair={(repair) => patchSettings({ repair })}
              />
            </Section>

            <Section title={t('bank.user.section.footprint')}>
              <FootprintEditor
                extent={editorExtent}
                footprint={geometry.footprint}
                edited={form.footprint !== null}
                disabled={locked}
                onPaint={paintFootprint}
                onResetDetected={() => patchForm({ footprint: null, mountingCells: null })}
              />
            </Section>

            <Section title={t('bank.user.section.mounting')}>
              <MountingEditor
                extent={editorExtent}
                footprint={geometry.footprint}
                kind={geometry.mountingKind}
                cells={geometry.mountingCells}
                disabled={locked}
                onKind={setKind}
                onPaint={paintPeg}
              />
            </Section>

            <Section title={t('bank.user.section.fits')}>
              <FitsToolEditor
                entries={form.fits}
                toolClasses={index.toolClasses}
                elements={index.elements}
                disabled={locked}
                onChange={(fits) => patchForm({ fits })}
              />
            </Section>
          </form>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-border bg-popover p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {offline ? (
          <output
            className="flex items-center gap-1.5 text-xs text-warn"
            data-testid="add-element-offline"
          >
            <WifiOffIcon className="size-3.5 shrink-0" aria-hidden />
            {t('bank.user.offline')}
          </output>
        ) : null}
        {submit.phase === 'error' ? (
          <p
            role="alert"
            className="flex items-center gap-1.5 text-xs text-destructive"
            data-testid="add-element-error"
          >
            <CircleAlertIcon className="size-3.5 shrink-0" aria-hidden />
            {t(submit.error.key, { detail: submit.error.detail })}
          </p>
        ) : null}
        {running ? (
          <output
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="add-element-progress"
          >
            <Loader2Icon className="size-3.5 animate-spin text-primary" aria-hidden />
            {stepKey ? t(stepKey) : t('bank.user.progress.starting')}
          </output>
        ) : problems.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[11px] text-muted-foreground">
            {problems.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex gap-2 max-sm:flex-col-reverse sm:justify-end">
          {edit === null ? (
            <Button
              variant="ghost"
              disabled={locked}
              onClick={onChangeFile}
              className="max-sm:h-10 sm:mr-auto"
            >
              {t('bank.user.changeFile')}
            </Button>
          ) : null}
          <Button variant="outline" className="max-sm:h-10" onClick={() => onCancel(running)}>
            {running ? t('bank.user.stopWaiting') : t('action.cancel')}
          </Button>
          <Button
            data-testid="add-element-submit"
            className="max-sm:h-10"
            disabled={offline || running || hasIssues(issues)}
            onClick={() => void submitNow()}
          >
            {edit === null ? t('bank.user.submit.add') : t('bank.user.submit.save')}
          </Button>
        </div>
      </div>
    </>
  );
}
