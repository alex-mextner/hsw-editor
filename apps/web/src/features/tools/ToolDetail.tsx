import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, BookmarkPlusIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { IconButton } from '@/components/IconButton.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { isTypingTarget } from '@/commands/typing.ts';
import { Fact, Facts, Section } from '@/features/bank/DetailSections.tsx';
import { PreviewBoundary } from '@/features/bank/PreviewBoundary.tsx';
import {
  claimPreviewSlot,
  previewSlotStore,
  releasePreviewSlot,
} from '@/features/bank/previewSlot.ts';
import { TagInput } from '@/features/bank/user/TagInput.tsx';
import { useI18n } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { layoutStore } from '@/state/layout.ts';
import {
  createClassTool,
  deleteTool,
  fetchTool,
  patchTool,
  toolRoutes,
  type ParamValues,
  type ToolClassInfo,
} from './api.ts';
import { addLibraryTool } from './actions.ts';
import { useClassHolding, useDebouncedValue, useToolHolding } from './hooks.ts';
import { HoldingSection } from './HoldingSection.tsx';
import { buildEntries, entryName, type LibraryEntry } from './model.ts';
import { ParamFields } from './ParamFields.tsx';
import { isCustomized, matchingPreset, valuesFor, withParam } from './paramValues.ts';
import { PartsSection } from './PartsSection.tsx';
import { libraryStore, openToolDetail, refreshToolLibrary } from './store.ts';
import { ToolPreview3D, type ModelPart } from './ToolPreview3D.tsx';
import { ToolThumb } from './ToolThumb.tsx';
import type { CustomTool } from '@hsw-editor/tools/contract';

const PARAM_DEBOUNCE_MS = 200;
/** Quiet time after the last slider/colour tick before a user tool is refitted on the server. */
const EDIT_BURST_MS = 500;

/** Large orbitable preview; the generated thumbnail underneath is the loading and error state. */
function DetailPreview({
  slotKey,
  entry,
  url,
  onParts,
}: {
  readonly slotKey: string;
  readonly entry: LibraryEntry;
  readonly url: string;
  readonly onParts: (parts: readonly ModelPart[]) => void;
}) {
  const t = useI18n().t;
  const slot = useStore(previewSlotStore);
  useEffect(() => {
    claimPreviewSlot(slotKey);
    return () => releasePreviewSlot(slotKey);
  }, [slotKey]);
  return (
    <div className="relative aspect-4/3 w-full shrink-0 bg-viewport">
      <div className="absolute inset-0 p-4">
        <ToolThumb
          key={entry.thumbUrl}
          id={entry.key}
          url={entry.thumbUrl}
          className="bg-transparent"
        />
      </div>
      {slot === slotKey ? (
        <PreviewBoundary fallback={null}>
          <ToolPreview3D url={url} onParts={onParts} className="absolute inset-0 bg-viewport" />
        </PreviewBoundary>
      ) : null}
      <p className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[10px] text-muted-foreground">
        {t('toolDetail.previewHint')}
      </p>
    </div>
  );
}

function ErrorLine({ message }: { readonly message: string | null }) {
  return message === null ? null : (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

// ---- built-in class ------------------------------------------------------------------------------

function PresetChips({
  info,
  values,
  onPick,
}: {
  readonly info: ToolClassInfo;
  readonly values: ParamValues;
  readonly onPick: (presetId: string | null) => void;
}) {
  const { t, locale } = useI18n();
  if (info.presets.length === 0) return null;
  const active = matchingPreset(info, values);
  return (
    <Section title={t('toolDetail.presets')}>
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {[null, ...info.presets.map((preset) => preset.id)].map((id) => {
          const preset = info.presets.find((entry) => entry.id === id);
          const label = preset
            ? preset.label[locale] || preset.label.en
            : t('toolDetail.presets.default');
          const on = active === id;
          return (
            <li key={id ?? 'default'}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => onPick(id)}
                className={cn(
                  'inline-flex h-6 items-center rounded-full border px-2 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                  on
                    ? 'border-primary bg-primary/15 text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted',
                )}
              >
                {label}
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function ClassDetail({
  entry,
  info,
  onBack,
}: {
  readonly entry: LibraryEntry;
  readonly info: ToolClassInfo;
  readonly onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const [presetId, setPresetId] = useState<string | null>(null);
  const [values, setValues] = useState<ParamValues>(() => valuesFor(info, null));
  const [parts, setParts] = useState<readonly ModelPart[]>([]);
  const [tags, setTags] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settled = useDebouncedValue(values, PARAM_DEBOUNCE_MS);
  const holding = useClassHolding(info.id, settled);
  const customized = isCustomized(info, values, presetId);
  const glb = toolRoutes.classGlb(info.id, settled, 0);
  // The wall gets the size and measured dimensions of what the preview shows (a chosen preset), not the class default.
  const entryNow = useMemo((): LibraryEntry => {
    if (holding.status !== 'ready') return entry;
    const { min, max } = holding.value.bboxMm;
    return {
      ...entry,
      dimsMm: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
      holdingDims: holding.value.holding.dims,
    };
  }, [entry, holding]);

  const pickPreset = (id: string | null): void => {
    setPresetId(id);
    setValues(valuesFor(info, id));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const tool = await createClassTool({ classId: info.id, params: values, tags });
      await refreshToolLibrary(true);
      openToolDetail(`tool:${tool.id}`);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DetailFrame
      entry={entry}
      onBack={onBack}
      preview={
        <DetailPreview slotKey={`tool:${entry.key}`} entry={entry} url={glb} onParts={setParts} />
      }
      footer={
        <>
          {customized ? (
            <>
              <Section title={t('toolDetail.tags')}>
                <TagInput
                  tags={tags}
                  onChange={setTags}
                  label={t('toolDetail.tags')}
                  testId="tool-detail-tags"
                  disabled={busy}
                />
              </Section>
              <Button
                variant="outline"
                className="w-full"
                disabled={busy}
                onClick={() => void save()}
                data-testid="tool-detail-save"
              >
                <BookmarkPlusIcon aria-hidden />
                {t('toolDetail.saveToLibrary')}
              </Button>
            </>
          ) : null}
          <ErrorLine message={error} />
          <AddButton
            entry={entryNow}
            disabled={customized || settled !== values || holding.status !== 'ready'}
            hint={customized ? t('toolDetail.addCustomizedHint') : null}
          />
        </>
      }
    >
      <Section title={t('toolDetail.class')}>
        <Facts>
          <Fact label={t('toolDetail.family')}>{info.familyLabel[locale]}</Fact>
          <Fact label={t('toolDetail.bankClass')}>{info.bankClass}</Fact>
        </Facts>
      </Section>
      <PresetChips info={info} values={values} onPick={pickPreset} />
      <Section title={t('toolDetail.params')}>
        <ParamFields
          schema={info.schema}
          values={values}
          onChange={(key, value) => {
            setValues((current) => withParam(info, current, key, value));
          }}
        />
      </Section>
      <PartsSection parts={parts} />
      <HoldingSection holding={holding} />
    </DetailFrame>
  );
}

// ---- user tool -----------------------------------------------------------------------------------

type ToolLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly tool: CustomTool };

function UserToolDetail({
  entry,
  classes,
  onBack,
}: {
  readonly entry: LibraryEntry;
  readonly classes: readonly ToolClassInfo[];
  readonly onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const [load, setLoad] = useState<ToolLoad>({ status: 'loading' });
  const [parts, setParts] = useState<readonly ModelPart[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchTool(entry.id).then(
      (tool) => {
        if (!cancelled) setLoad({ status: 'ready', tool });
      },
      (failure: unknown) => {
        if (!cancelled) {
          setLoad({
            status: 'error',
            message: failure instanceof Error ? failure.message : String(failure),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entry.id]);

  const tool = load.status === 'ready' ? load.tool : null;
  const version = tool?.updatedAt ?? entry.updatedAt;
  const holding = useToolHolding(entry.id, version);
  const info = classes.find((cls) => cls.id === tool?.classId);

  // Edits run one after the other (each refit answers before the next request), so a late answer never overwrites a newer one.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const apply = useCallback(
    (patch: Parameters<typeof patchTool>[1]): Promise<void> => {
      const run = async (): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
          const next = await patchTool(entry.id, patch);
          setLoad({ status: 'ready', tool: next });
          await refreshToolLibrary(true);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };
      chain.current = chain.current.then(run);
      return chain.current;
    },
    [entry.id],
  );

  // Sliders, number fields and colour pickers fire continuously: the edits of a burst are merged into one patch.
  const queued = useRef<{ params: ParamValues; partColors: Record<string, string> }>({ params: {}, partColors: {} });
  const flushTimer = useRef<number | undefined>(undefined);
  const [pending, setPending] = useState<{ params: ParamValues; partColors: Record<string, string> }>({
    params: {},
    partColors: {},
  });
  const flush = useCallback((): void => {
    const { params, partColors } = queued.current;
    if (Object.keys(params).length === 0 && Object.keys(partColors).length === 0) return;
    queued.current = { params: {}, partColors: {} };
    // The edited values stay shown until the refit answers, so the controls do not jump back meanwhile.
    void apply({
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(Object.keys(partColors).length > 0 ? { partColors } : {}),
    }).finally(() => setPending(queued.current));
  }, [apply]);
  const queue = useCallback(
    (edit: { params?: ParamValues; partColors?: Record<string, string> }): void => {
      queued.current = {
        params: { ...queued.current.params, ...edit.params },
        partColors: { ...queued.current.partColors, ...edit.partColors },
      };
      setPending(queued.current);
      window.clearTimeout(flushTimer.current);
      flushTimer.current = window.setTimeout(flush, EDIT_BURST_MS);
    },
    [flush],
  );
  // Leaving the page within the burst window still saves what the user changed.
  useEffect(
    () => () => {
      window.clearTimeout(flushTimer.current);
      flush();
    },
    [flush],
  );

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await deleteTool(entry.id);
      await refreshToolLibrary(true);
      onBack();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setBusy(false);
    }
  };

  const [dimDraft, setDimDraft] = useState<Record<string, string>>({});
  const dimsMm = tool?.dimensionsMm;
  const commitDim = (key: 'length' | 'width' | 'thickness'): void => {
    const raw = dimDraft[key];
    if (raw === undefined || dimsMm === undefined) return;
    const value = Number(raw);
    setDimDraft(({ [key]: _done, ...rest }) => rest);
    if (Number.isFinite(value) && value > 0 && value !== dimsMm[key]) {
      void apply({ dimensionsMm: { [key]: value } });
    }
  };

  const body = (() => {
    if (load.status === 'loading') {
      return <div className="h-24 animate-pulse rounded-md bg-muted" />;
    }
    if (load.status === 'error') return <ErrorLine message={load.message} />;
    const { tool: current } = load;
    return (
      <>
        <Section title={t('toolDetail.name')}>
          <Input
            key={`${current.id}:${current.updatedAt}`}
            defaultValue={current.name[locale] ?? ''}
            placeholder={current.name.en ?? current.name.ru ?? ''}
            aria-label={t('toolDetail.name')}
            disabled={busy}
            data-testid="tool-detail-name"
            onBlur={(event) => {
              const next = event.target.value.trim();
              if (next !== '' && next !== current.name[locale])
                void apply({ name: { [locale]: next } });
            }}
          />
        </Section>
        <Section title={t('toolDetail.tags')}>
          <TagInput
            tags={current.tags}
            onChange={(tags) => void apply({ tags })}
            label={t('toolDetail.tags')}
            testId="tool-detail-tags"
            disabled={busy}
          />
        </Section>
        <Section title={t('toolDetail.dimensions')}>
          <div className="grid grid-cols-3 gap-2" data-testid="tool-detail-dims">
            {(['length', 'width', 'thickness'] as const).map((key) => (
              <label key={key} className="grid gap-1 text-xs text-muted-foreground">
                {t(`toolDetail.dim.${key}`)}
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0.1}
                  step={0.5}
                  value={dimDraft[key] ?? `${Math.round(current.dimensionsMm[key] * 10) / 10}`}
                  disabled={busy}
                  className="h-7 text-right font-mono text-xs"
                  onChange={(event) => setDimDraft({ ...dimDraft, [key]: event.target.value })}
                  onBlur={() => commitDim(key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commitDim(key);
                  }}
                />
              </label>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t(`toolDetail.dimSource.${current.dimensionsMm.source}`)}
            {' · '}
            {t('toolDetail.fit', {
              method: t(`toolDetail.fitMethod.${current.fit.method}`),
              percent: Math.round(current.fit.confidence * 100),
            })}
          </p>
        </Section>
        {info ? (
          <Section title={t('toolDetail.params')}>
            <ParamFields
              schema={info.schema}
              values={{ ...valuesFor(info, null), ...current.params, ...pending.params }}
              onChange={(key, value) => {
                const base = { ...valuesFor(info, null), ...current.params, ...pending.params };
                queue({ params: { [key]: withParam(info, base, key, value)[key] ?? value } });
              }}
            />
          </Section>
        ) : null}
        <PartsSection
          parts={parts.map((part) => ({ ...part, color: pending.partColors[part.name] ?? part.color }))}
          onColor={(part, color) => queue({ partColors: { [part]: color } })}
        />
        <HoldingSection holding={holding} />
      </>
    );
  })();

  return (
    <DetailFrame
      entry={entry}
      onBack={onBack}
      preview={
        <DetailPreview
          slotKey={`tool:${entry.key}`}
          entry={entry}
          url={toolRoutes.toolGlb(entry.id, version, 0)}
          onParts={setParts}
        />
      }
      footer={
        <>
          <ErrorLine message={error} />
          <div className="flex gap-2">
            {confirmDelete ? (
              <>
                <Button
                  variant="destructive"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void remove()}
                  data-testid="tool-detail-delete-confirm"
                >
                  {t('toolDetail.delete.confirm')}
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setConfirmDelete(false)}
                >
                  {t('toolDetail.delete.cancel')}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                className="flex-1"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
                data-testid="tool-detail-delete"
              >
                <Trash2Icon aria-hidden />
                {t('toolDetail.delete')}
              </Button>
            )}
          </div>
          <AddButton entry={entry} disabled={busy || tool === null} hint={null} />
        </>
      }
    >
      {body}
    </DetailFrame>
  );
}

// ---- shared frame --------------------------------------------------------------------------------

function AddButton({
  entry,
  disabled,
  hint,
}: {
  readonly entry: LibraryEntry;
  readonly disabled: boolean;
  readonly hint: string | null;
}) {
  const { t, locale } = useI18n();
  const [failed, setFailed] = useState(false);
  return (
    <>
      {hint === null ? null : <p className="text-[11px] text-muted-foreground">{hint}</p>}
      {failed ? (
        <p role="alert" className="text-[11px] text-warn">
          {t('toolLib.notice.noWall')}
        </p>
      ) : null}
      <Button
        className="w-full"
        disabled={disabled}
        data-testid="tool-detail-add"
        onClick={() => setFailed(!addLibraryTool(entry, locale).ok)}
      >
        <PlusIcon aria-hidden />
        {t('toolDetail.add')}
      </Button>
    </>
  );
}

function DetailFrame({
  entry,
  onBack,
  preview,
  footer,
  children,
}: {
  readonly entry: LibraryEntry;
  readonly onBack: () => void;
  readonly preview: ReactNode;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  const { t, locale } = useI18n();
  // Window-level, because the card that had focus is gone and focus falls back to <body>.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || isTypingTarget(event.target)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (!layoutStore.get().leftOpen) return;
      event.preventDefault();
      onBack();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onBack]);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel" data-testid="tool-detail">
      <header className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <IconButton label={t('toolDetail.back')} shortcut="Esc" onClick={onBack}>
          <ArrowLeftIcon aria-hidden />
        </IconButton>
        <div className="flex min-w-0 items-center gap-1.5">
          <h2 className="truncate text-sm font-semibold">{entryName(entry, locale)}</h2>
          {entry.kind === 'tool' ? (
            <span
              title={t('toolLib.mineTitle')}
              className="inline-flex h-4 shrink-0 items-center rounded bg-primary/15 px-1 text-[10px] leading-none text-primary"
            >
              {t('toolLib.mine')}
            </span>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {preview}
        <div className="flex flex-col gap-4 p-3">{children}</div>
      </div>
      <footer className="flex flex-col gap-2 border-t border-border bg-panel p-2">{footer}</footer>
    </div>
  );
}

/** Detail page of one library entry: 3D preview, parameters, materials and the holding interface. */
export function ToolDetail({
  entryKey,
  onBack,
}: {
  readonly entryKey: string;
  readonly onBack: () => void;
}) {
  const library = useStore(libraryStore);
  const entry = useMemo(
    () =>
      library.status === 'ready'
        ? (buildEntries(library.classes, library.tools).find((candidate) => candidate.key === entryKey) ?? null)
        : null,
    [library, entryKey],
  );

  // A tool that was deleted (or never existed) falls back to the list instead of an empty page.
  useEffect(() => {
    if (library.status === 'error' || (library.status === 'ready' && entry === null)) onBack();
  }, [library.status, entry, onBack]);

  if (library.status !== 'ready' || entry === null) return null;
  const info = entry.kind === 'class' ? library.classes.find((cls) => cls.id === entry.id) : undefined;
  if (info) return <ClassDetail key={entry.key} entry={entry} info={info} onBack={onBack} />;
  return <UserToolDetail key={entry.key} entry={entry} classes={library.classes} onBack={onBack} />;
}
