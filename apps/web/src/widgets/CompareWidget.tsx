import { useMemo, useState } from 'react';
import type { ModelRef } from '@hsw-editor/core';
import { api } from '@/api/http.ts';
import { bankStore } from '@/bank/client.ts';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { CompareCanvas } from './CompareCanvas.tsx';
import { CompareCard } from './CompareCard.tsx';
import { CompareGhostPicker } from './CompareGhostPicker.tsx';
import {
  CompareOverlayLegend,
  DEFAULT_OVERLAY_STYLE,
  type OverlayStyle,
} from './CompareOverlayLegend.tsx';
import { CompareViewport } from './CompareViewport.tsx';
import {
  buildAcceptOps,
  buildRejectOps,
  candidateColor,
  itemDimensions,
  MAX_COMPARED,
  pickCompareIds,
  referenceFor,
} from './compareMath.ts';

const MODES = ['side', 'overlay', 'ghost'] as const;
type CompareMode = (typeof MODES)[number];

const GHOST_OPACITY = 0.5;
/** Colour of the item's size yardstick; neutral so it never reads as a candidate. */
const REFERENCE_COLOR = '#9ca3af';

/** What the user decided; the request host turns it into the answer sent to the asker. */
export interface CompareOutcome {
  readonly chosenId: string | null;
  readonly rejectedIds: readonly string[];
}

interface CompareWidgetProps {
  readonly modelRefIds: readonly string[];
  readonly itemId?: string;
  readonly onDone: (outcome: CompareOutcome) => void;
}

function isMode(value: unknown): value is CompareMode {
  return MODES.some((mode) => mode === value);
}

export function CompareWidget({ modelRefIds, itemId, onDone }: CompareWidgetProps) {
  const { t, tn } = useI18n();
  const session = useStore(sessionStore);
  const bank = useStore(bankStore);
  const [mode, setMode] = useState<CompareMode>('side');
  const [styles, setStyles] = useState<ReadonlyMap<string, OverlayStyle>>(new Map());
  const [ghostId, setGhostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const wall = session?.wall ?? null;
  const candidates = useMemo<readonly ModelRef[]>(() => {
    if (!wall) return [];
    const found = modelRefIds.flatMap((id) => wall.models.find((model) => model.id === id) ?? []);
    const keep = new Set(pickCompareIds(found, MAX_COMPARED));
    return found.filter((model) => keep.has(model.id));
  }, [wall, modelRefIds]);

  const colors = useMemo(
    () => new Map(candidates.map((model, index) => [model.id, candidateColor(index)])),
    [candidates],
  );

  if (!wall) return null;
  const item = itemId === undefined ? undefined : wall.items.find((entry) => entry.id === itemId);
  const bankDims =
    item?.bankId !== undefined && bank.status === 'ready'
      ? bank.byId.get(item.bankId)?.dimsMm
      : undefined;
  const itemDims = itemDimensions(
    item,
    wall.models,
    new Set(candidates.map((m) => m.id)),
    bankDims,
  );
  const photoId = item?.source.photoId;
  const photo =
    photoId === undefined ? undefined : wall.photos.find((entry) => entry.id === photoId);
  const photoUrl = photo ? api.photoUrl(wall.id, photo.id) : null;
  const ghost = candidates.find((model) => model.id === ghostId) ?? candidates[0];

  function finish(chosenId: string | null): void {
    setSettled(true);
    onDone({
      chosenId,
      rejectedIds: candidates.filter((model) => model.id !== chosenId).map((model) => model.id),
    });
  }

  function accept(model: ModelRef): void {
    const result = submitOps(buildAcceptOps(candidates, model.id, item), 'compare-accept');
    if (result.ok) finish(model.id);
    else setError(result.error.message);
  }

  function reject(model: ModelRef): void {
    const result = submitOps(buildRejectOps(model), 'compare-reject');
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setError(null);
    if (candidates.every((other) => other.id === model.id || other.status === 'rejected')) {
      finish(null);
    }
  }

  const card = (model: ModelRef, withViewport: boolean) => {
    const reference = referenceFor(model, itemDims, candidates);
    return (
      <CompareCard
        key={model.id}
        model={model}
        color={colors.get(model.id) ?? candidateColor(0)}
        reference={reference}
        itemLocked={item?.locked ?? false}
        busy={settled}
        onAccept={() => accept(model)}
        onReject={() => reject(model)}
        viewport={
          withViewport ? (
            <CompareViewport
              wallId={wall.id}
              className="h-44"
              entries={[
                {
                  model,
                  color: colors.get(model.id) ?? candidateColor(0),
                  opacity: 1,
                  tint: false,
                },
              ]}
              reference={itemDims}
              referenceColor={REFERENCE_COLOR}
            />
          ) : undefined
        }
      />
    );
  };

  const overlayEntries = candidates.flatMap((model) => {
    const style = styles.get(model.id) ?? DEFAULT_OVERLAY_STYLE;
    return style.visible
      ? [
          {
            model,
            color: colors.get(model.id) ?? candidateColor(0),
            opacity: style.opacity,
            tint: true,
          },
        ]
      : [];
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label={t('compare.modes')}
          variant="outline"
          size="sm"
          spacing={0}
          value={[mode]}
          onValueChange={(value) => {
            const next = value[0];
            if (isMode(next)) setMode(next);
          }}
        >
          {MODES.map((value) => (
            <ToggleGroupItem
              key={value}
              value={value}
              className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            >
              {t(`compare.mode.${value}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="text-xs text-muted-foreground">
          {tn('compare.candidates', candidates.length)}
        </span>
      </div>

      {candidates.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t('compare.empty')}
        </p>
      ) : (
        <div ref={setContainer} className="relative">
          {mode === 'side' ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
              {photoUrl ? (
                <figure className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-2">
                  <img
                    src={photoUrl}
                    alt={t('compare.photo')}
                    className="h-44 w-full rounded-md bg-viewport object-contain"
                  />
                  <figcaption className="text-xs text-muted-foreground">
                    {t('compare.photo')}
                  </figcaption>
                </figure>
              ) : null}
              {candidates.map((model) => card(model, true))}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {mode === 'overlay' ? (
                <>
                  <CompareViewport
                    wallId={wall.id}
                    className="h-72"
                    entries={overlayEntries}
                    reference={itemDims}
                    referenceColor={REFERENCE_COLOR}
                  />
                  <CompareOverlayLegend
                    candidates={candidates}
                    colors={colors}
                    styles={styles}
                    onChange={(id, style) => setStyles(new Map(styles).set(id, style))}
                  />
                </>
              ) : (
                <>
                  <CompareGhostPicker
                    candidates={candidates}
                    colors={colors}
                    selectedId={ghost?.id}
                    onSelect={setGhostId}
                  />
                  {ghost ? (
                    <CompareViewport
                      wallId={wall.id}
                      className="h-72"
                      entries={[
                        {
                          model: ghost,
                          color: colors.get(ghost.id) ?? candidateColor(0),
                          opacity: GHOST_OPACITY,
                          tint: true,
                        },
                      ]}
                      reference={itemDims}
                      referenceColor={REFERENCE_COLOR}
                      background={
                        photoUrl ? (
                          <img
                            src={photoUrl}
                            alt={t('compare.photo')}
                            className="absolute inset-0 size-full object-contain"
                          />
                        ) : undefined
                      }
                    />
                  ) : null}
                  {photoUrl ? null : (
                    <p className="text-xs text-muted-foreground">{t('compare.ghost.noPhoto')}</p>
                  )}
                </>
              )}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]">
                {candidates.map((model) => card(model, false))}
              </div>
            </div>
          )}
          {container ? <CompareCanvas eventSource={container} /> : null}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t('compare.error', { message: error })}
        </p>
      ) : null}
    </div>
  );
}
