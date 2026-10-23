import { useEffect, useState, type ReactNode } from 'react';
import { CheckIcon, RulerIcon, ScissorsIcon, Trash2Icon, Undo2Icon } from 'lucide-react';
import {
  type DimensionKey,
  DimensionKeySchema,
  type Draft,
  type DraftObject,
  MAX_DIMENSION_MM,
  MIN_DIMENSION_MM,
} from '@hsw-editor/tools/contract';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import {
  claimPreviewSlot,
  previewSlotStore,
  releasePreviewSlot,
} from '@/features/bank/previewSlot.ts';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { toolRoutes, type ToolClassInfo } from '../api.ts';
import { ToolPreview3D } from '../ToolPreview3D.tsx';
import { CandidateCompare } from './CandidateCompare.tsx';
import type { DraftEdits } from './useDraftEdits.ts';
import { parseTypedDimension, percent, topClasses } from './wizardModel.ts';

const PREVIEW_SLOT = 'tool-wizard-preview';
const GENERIC = '__generic__';
const DIM_KEYS = DimensionKeySchema.options;

function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h4 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {children}
    </section>
  );
}

interface ObjectEditorProps {
  readonly draft: Draft;
  readonly object: DraftObject;
  readonly classes: readonly ToolClassInfo[];
  readonly edits: DraftEdits;
}

/**
 * Everything the user decides about one detected object: name, class (top-3 with confidence, any class by hand or
 * the generic shape), real dimensions, the live 3D model of the current fit, the built-in candidates to compare,
 * accept or discard, and splitting a mask that covers several tools.
 */
export function ObjectEditor({ draft, object, classes, edits }: ObjectEditorProps) {
  const { t, locale } = useI18n();
  const slot = useStore(previewSlotStore);
  useEffect(() => {
    claimPreviewSlot(PREVIEW_SLOT);
    return () => releasePreviewSlot(PREVIEW_SLOT);
  }, []);
  const [dimDraft, setDimDraft] = useState<Record<string, string>>({});
  const [dimError, setDimError] = useState<
    Partial<Record<DimensionKey, 'invalid' | 'range'>>
  >({});
  const [splitInto, setSplitInto] = useState(2);
  const locked = object.status === 'added';
  const top = topClasses(object, 3);
  const className = (id: string): string =>
    classes.find((cls) => cls.id === id)?.name[locale] ?? id;
  const name = object.name[locale] ?? object.name.en ?? object.name.ru ?? '';
  const preview = object.preview;
  const dims = object.dimensionsMm;
  const typed = object.userDimensions;

  /**
   * Sends a typed size, or shows why it is refused (not a number / outside the sane range): a refused value is never
   * sent and stays in the field next to its message, so nothing changes silently.
   */
  const commitTyped = (key: DimensionKey, send: (valueMm: number) => void): void => {
    const raw = dimDraft[key];
    if (raw === undefined) return;
    const parsed = parseTypedDimension(raw, key);
    if (parsed.kind === 'invalid' || parsed.kind === 'range') {
      setDimError((previous) => ({ ...previous, [key]: parsed.kind }));
      return;
    }
    setDimError(({ [key]: _done, ...rest }) => rest);
    setDimDraft(({ [key]: _done, ...rest }) => rest);
    if (parsed.kind === 'ok') send(parsed.valueMm);
  };

  const typeInto = (key: DimensionKey, raw: string): void => {
    setDimDraft((previous) => ({ ...previous, [key]: raw }));
    setDimError(({ [key]: _done, ...rest }) => rest);
  };

  /** No size is known yet (nothing to scale by): one typed real length is enough to fit and add the tool. */
  const commitLength = (): void =>
    commitTyped(
      'length',
      (valueMm) => void edits.patch(object.key, { dimensionsMm: { length: valueMm } }),
    );

  const commitDim = (key: DimensionKey): void =>
    commitTyped(key, (valueMm) => {
      // retyping the size already asked for changes nothing
      if (typed?.[key] !== valueMm)
        void edits.patch(object.key, { dimensionsMm: { [key]: valueMm } });
    });

  const dimMessage = (key: DimensionKey): string | null => {
    const problem = dimError[key];
    if (problem === undefined) return null;
    return problem === 'range'
      ? t('toolWizard.editor.dimOutOfRange', { min: MIN_DIMENSION_MM[key], max: MAX_DIMENSION_MM })
      : t('toolWizard.editor.dimInvalid');
  };

  return (
    <div className="grid gap-4" data-testid="object-editor" data-key={object.key}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="relative aspect-square overflow-hidden rounded-lg border border-border bg-muted/60">
          {object.images.crop === undefined ? null : (
            <img
              src={toolRoutes.draftFile(draft.id, object.images.crop)}
              alt={t('toolWizard.editor.cropAlt')}
              className="size-full object-contain p-1"
            />
          )}
          <span className="absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
            {t('toolWizard.editor.crop')}
          </span>
        </div>
        <div className="relative aspect-square overflow-hidden rounded-lg border border-border bg-viewport">
          {preview !== null && slot === PREVIEW_SLOT ? (
            <ToolPreview3D
              url={`${toolRoutes.draftFile(draft.id, preview.glb)}?v=${encodeURIComponent(draft.updatedAt)}`}
              className="absolute inset-0"
            />
          ) : (
            <p className="flex size-full items-center justify-center px-3 text-center text-xs text-muted-foreground">
              {t('toolWizard.editor.noPreview')}
            </p>
          )}
          <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-background/80 px-1 text-[10px] text-muted-foreground">
            {t('toolWizard.editor.preview')}
          </span>
        </div>
      </div>

      <Block title={t('toolWizard.editor.name')}>
        <Input
          key={`${object.key}:${name}`}
          defaultValue={name}
          disabled={edits.busy || locked}
          aria-label={t('toolWizard.editor.name')}
          placeholder={
            object.classId === null ? t('toolWizard.class.generic') : className(object.classId)
          }
          data-testid="wizard-object-name"
          onBlur={(event) => {
            const next = event.target.value.trim();
            if (next !== '' && next !== name)
              void edits.patch(object.key, { name: { [locale]: next } });
          }}
        />
      </Block>

      <Block title={t('toolWizard.editor.class')}>
        <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0" data-testid="wizard-classes">
          <legend className="sr-only">{t('toolWizard.editor.class')}</legend>
          {top.map((suggestion) => {
            const on = object.classId === suggestion.classId;
            return (
              <label
                key={suggestion.classId}
                className={cn(
                  'grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-2 gap-y-1 rounded-lg border px-2.5 py-1.5 text-left text-xs has-focus-visible:ring-3 has-focus-visible:ring-ring/50',
                  on ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted',
                  (edits.busy || locked) && 'cursor-default opacity-60',
                )}
              >
                <input
                  type="radio"
                  name={`class-${object.key}`}
                  checked={on}
                  disabled={edits.busy || locked}
                  onChange={() => void edits.patch(object.key, { classId: suggestion.classId })}
                  className="sr-only"
                />
                <span className="font-medium">{className(suggestion.classId)}</span>
                <span className="font-mono text-[11px]">{percent(suggestion.score)}%</span>
                <span
                  aria-hidden
                  className="col-span-2 block h-1 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${percent(suggestion.score)}%` }}
                  />
                </span>
              </label>
            );
          })}
        </fieldset>
        <label className="grid gap-1 text-xs text-muted-foreground">
          {t('toolWizard.editor.otherClass')}
          <select
            value={object.classId ?? GENERIC}
            disabled={edits.busy || locked}
            data-testid="wizard-class-select"
            onChange={(event) =>
              void edits.patch(object.key, {
                classId: event.target.value === GENERIC ? null : event.target.value,
              })
            }
            className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm text-foreground"
          >
            <option value={GENERIC}>{t('toolWizard.class.generic')}</option>
            {classes.map((cls) => (
              <option key={cls.id} value={cls.id}>
                {cls.name[locale]}
              </option>
            ))}
          </select>
        </label>
        {object.classOverridden ? (
          <p className="text-[11px] text-muted-foreground">{t('toolWizard.editor.overridden')}</p>
        ) : null}
      </Block>

      <Block title={t('toolWizard.editor.dimensions')}>
        {object.needsScale || dims === null ? (
          <>
            <output className="flex items-start gap-1.5 text-xs text-warn">
              <RulerIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t('toolWizard.object.needsScale')}
            </output>
            {object.observation === null || locked ? null : (
              <label className="grid gap-1 text-xs text-muted-foreground">
                {t('toolDetail.dim.length')}
                <Input
                  type="number"
                  inputMode="decimal"
                  min={MIN_DIMENSION_MM.length}
                  max={MAX_DIMENSION_MM}
                  step={0.5}
                  value={dimDraft['length'] ?? ''}
                  disabled={edits.busy}
                  aria-invalid={dimError.length !== undefined}
                  className="h-7 w-32 text-right font-mono text-xs"
                  data-testid="wizard-length-only"
                  onChange={(event) => typeInto('length', event.target.value)}
                  onBlur={commitLength}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitLength();
                  }}
                />
              </label>
            )}
            {dimMessage('length') === null ? null : (
              <p
                role="alert"
                className="text-[11px] text-destructive"
                data-testid="wizard-dim-error"
                data-dim="length"
              >
                {dimMessage('length')}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2" data-testid="wizard-dims">
              {DIM_KEYS.map((key) => (
                <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                  {t(`toolDetail.dim.${key}`)}
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={MIN_DIMENSION_MM[key]}
                    max={MAX_DIMENSION_MM}
                    step={0.5}
                    value={dimDraft[key] ?? `${Math.round(dims[key] * 10) / 10}`}
                    disabled={edits.busy || locked}
                    aria-invalid={dimError[key] !== undefined}
                    className="h-7 text-right font-mono text-xs"
                    onChange={(event) => typeInto(key, event.target.value)}
                    onBlur={() => commitDim(key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitDim(key);
                    }}
                  />
                </label>
              ))}
            </div>
            {DIM_KEYS.map((key) => {
              const message = dimMessage(key);
              return message === null ? null : (
                <p
                  key={key}
                  role="alert"
                  className="text-[11px] text-destructive"
                  data-testid="wizard-dim-error"
                  data-dim={key}
                >
                  {t(`toolWizard.editor.dimName.${key}`)}: {message}
                </p>
              );
            })}
            {object.dimensionAdjustments.map((adjustment) => (
              <output
                key={adjustment.key}
                className="flex items-start gap-1.5 text-[11px] text-warn"
                data-testid="wizard-dim-adjusted"
                data-dim={adjustment.key}
              >
                <RulerIcon className="mt-0.5 size-3 shrink-0" aria-hidden />
                {t('toolWizard.editor.dimAdjusted', {
                  name: t(`toolWizard.editor.dimName.${adjustment.key}`),
                  requested: Math.round(adjustment.requestedMm * 10) / 10,
                  actual: Math.round(adjustment.actualMm * 10) / 10,
                  reason: t(`toolWizard.editor.dimReason.${adjustment.reason}`),
                })}
              </output>
            ))}
            <p className="text-[11px] text-muted-foreground">
              {object.dimensionsEstimated
                ? t('toolWizard.editor.dimsEstimated')
                : typed !== undefined && Object.keys(typed).length > 0
                  ? t('toolWizard.editor.dimsTyped')
                  : t('toolWizard.editor.dimsPhoto')}
              {object.fit === null
                ? ''
                : ` · ${t('toolWizard.editor.fit', { percent: percent(object.fit.confidence) })}`}
            </p>
          </>
        )}
      </Block>

      <Block title={t('toolWizard.editor.compare')}>
        <CandidateCompare
          object={object}
          classes={classes}
          disabled={edits.busy || locked}
          onPick={(classId) => void edits.patch(object.key, { classId })}
        />
      </Block>

      {object.error === undefined ? null : (
        <p role="alert" className="text-xs text-destructive">
          {object.error}
        </p>
      )}
      {locked ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {object.status === 'accepted' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={edits.busy}
              onClick={() => void edits.patch(object.key, { status: 'pending' })}
            >
              <Undo2Icon aria-hidden />
              {t('toolWizard.editor.unaccept')}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={edits.busy}
              data-testid="wizard-accept"
              onClick={() => void edits.patch(object.key, { status: 'accepted' })}
            >
              <CheckIcon aria-hidden />
              {t('toolWizard.editor.accept')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={edits.busy || object.status === 'discarded'}
            data-testid="wizard-discard"
            onClick={() => void edits.patch(object.key, { status: 'discarded' })}
          >
            <Trash2Icon aria-hidden />
            {t('toolWizard.editor.discard')}
          </Button>
          <span className="ml-auto flex items-center gap-1">
            <select
              aria-label={t('toolWizard.editor.splitParts')}
              value={splitInto}
              onChange={(event) => setSplitInto(Number(event.target.value))}
              className="h-7 rounded-lg border border-input bg-transparent px-1 text-xs"
            >
              {[2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={edits.busy}
              data-testid="wizard-split"
              onClick={() => void edits.split(object.key, splitInto)}
            >
              <ScissorsIcon aria-hidden />
              {t('toolWizard.editor.split')}
            </Button>
          </span>
        </div>
      )}
    </div>
  );
}
