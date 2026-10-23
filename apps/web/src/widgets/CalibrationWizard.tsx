import { useMemo, useState } from 'react';
import { RotateCcwIcon, Undo2Icon } from 'lucide-react';
import type { Calibration } from '@hsw-editor/core';
import {
  boardExtent,
  DEFAULT_REFERENCE_MM,
  reduceWizard,
  startWizard,
  toCoreCalibration,
  wizardPreview,
  wizardPrompt,
  type ReferenceAxis,
  type WizardProblem,
  type WizardState,
  type WizardWarning,
} from '@hsw-editor/overlay';
import { api } from '@/api/http.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n, type MessageKey } from '@/i18n/index.ts';
import { cn } from '@/lib/cn.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { CalibrationGrid } from './CalibrationGrid.tsx';
import { CalibrationViewer, type Marker } from './CalibrationViewer.tsx';
import { useGridDetection } from './calibrationDetect.ts';
import {
  formatNumber,
  isLengthUnit,
  LENGTH_UNITS,
  parseLength,
  unitStore,
  type LengthUnit,
} from './units.ts';
import { boardOutlinePx, percent } from './calibrationWizardView.ts';

export type CalibrationMode = 'two-point' | 'corners' | 'grid';

export interface CalibrationOutcome {
  readonly method: Calibration['method'];
}

interface CalibrationWizardProps {
  readonly photoId: string;
  readonly mode: CalibrationMode;
  readonly onDone: (outcome: CalibrationOutcome) => void;
  readonly onCancel?: () => void;
  readonly className?: string;
}

const AXES: readonly ReferenceAxis[] = ['free', 'horizontal', 'vertical'];

function isMode(value: unknown): value is CalibrationMode {
  return value === 'two-point' || value === 'corners' || value === 'grid';
}

function isUnit(value: unknown): value is LengthUnit {
  return typeof value === 'string' && isLengthUnit(value);
}

function isAxis(value: unknown): value is ReferenceAxis {
  return AXES.some((axis) => axis === value);
}

const WARNING_KEY: Readonly<Record<WizardWarning, MessageKey>> = {
  'short-reference': 'photo.wizard.warn.shortReference',
  'single-scale-only-at-reference': 'photo.wizard.warn.singleScale',
  'large-reprojection': 'photo.wizard.warn.largeReprojection',
};

const PROBLEM_KEY: Readonly<Record<WizardProblem, MessageKey>> = {
  'need-clicks': 'photo.wizard.problem.needClicks',
  'invalid-length': 'photo.wizard.problem.invalidLength',
  'invalid-size': 'photo.wizard.problem.invalidSize',
  'clicks-too-close': 'photo.wizard.problem.tooClose',
  'corner-order': 'photo.wizard.problem.cornerOrder',
  degenerate: 'photo.wizard.problem.degenerate',
};

/**
 * Calibrates a wall photo: two clicks on a tape + its typed length, four clicks on a rectangle of known size
 * (perspective is rectified), or the detected honeycomb grid. The result is one `setCalibration` op.
 */
export function CalibrationWizard({
  photoId,
  mode,
  onDone,
  onCancel,
  className,
}: CalibrationWizardProps) {
  const { t, locale } = useI18n();
  const wall = useStore(sessionStore)?.wall ?? null;
  const photo = wall?.photos.find((entry) => entry.id === photoId);
  const extent = useMemo(() => (wall ? boardExtent(wall.board) : null), [wall]);
  const [tab, setTab] = useState<CalibrationMode>(mode);
  const [state, setState] = useState<WizardState | null>(null);
  const unit = useStore(unitStore);
  const [lengthText, setLengthText] = useState(() => formatNumber(DEFAULT_REFERENCE_MM, unit));
  const [widthText, setWidthText] = useState(() => formatNumber(extent?.widthMm ?? 0, unit));
  const [heightText, setHeightText] = useState(() => formatNumber(extent?.heightMm ?? 0, unit));
  const [error, setError] = useState<string | null>(null);
  const detection = useGridDetection(wall?.id ?? '', photoId);

  const image = useMemo(
    () => (photo ? { width: photo.width, height: photo.height } : null),
    [photo],
  );
  const wizard = useMemo<WizardState | null>(() => {
    if (tab === 'grid' || !extent) return null;
    const base = state?.mode === tab ? state : startWizard(tab, extent);
    // The typed numbers (in the chosen unit) are the source of truth for every length.
    return base.mode === 'two-point'
      ? { ...base, realMm: parseLength(lengthText, unit) ?? Number.NaN }
      : {
          ...base,
          widthMm: parseLength(widthText, unit) ?? Number.NaN,
          heightMm: parseLength(heightText, unit) ?? Number.NaN,
        };
  }, [state, tab, extent, lengthText, widthText, heightText, unit]);
  const result = useMemo(
    () => (wizard && image && extent ? wizardPreview(wizard, image, extent) : null),
    [wizard, image, extent],
  );
  const outline = useMemo(
    () =>
      result?.ok && image && extent ? boardOutlinePx(result.preview.result, image, extent) : null,
    [result, image, extent],
  );

  if (!wall || !photo || !image || !extent) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t('calibration.noPhoto')}
      </p>
    );
  }

  const num = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });
  const fixed = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  const dispatch = (event: Parameters<typeof reduceWizard>[1]): void => {
    if (wizard) setState(reduceWizard(wizard, event));
  };

  const switchTab = (next: CalibrationMode): void => {
    setTab(next);
    setError(null);
    setState(null);
  };

  const changeUnit = (next: LengthUnit): void => {
    // The physical size stays the same (1000 mm becomes 100 cm), only its notation changes.
    const reformat = (text: string): string => {
      const mm = parseLength(text, unit);
      return mm === null ? text : formatNumber(mm, next);
    };
    unitStore.set(next);
    setLengthText(reformat(lengthText));
    setWidthText(reformat(widthText));
    setHeightText(reformat(heightText));
  };

  const apply = (calibration: Calibration): void => {
    const outcome = submitOps([{ type: 'setCalibration', photoId, calibration }], 'calibrate');
    if (outcome.ok) onDone({ method: calibration.method });
    else setError(outcome.error.message);
  };

  const review = detection.state.phase === 'review' ? detection.state : null;
  const prompt = wizard ? wizardPrompt(wizard) : null;
  const markers: readonly Marker[] =
    wizard === null
      ? []
      : wizard.clicks.map((point, index) => ({
          point: [point[0], point[1]] as const,
          label:
            wizard.mode === 'two-point'
              ? index === 0
                ? 'A'
                : 'B'
              : t(`photo.corner.${CORNER_LABELS[index] ?? 'lower-left'}`),
        }));
  const gridOverlay = review?.result.points?.map((entry) => entry.px);
  const preview = result?.ok ? result.preview : null;
  const problem = result && !result.ok ? result.problem : null;
  const complete = wizard !== null && prompt?.kind === 'confirm';
  const placing = wizard !== null && prompt?.kind === 'click';
  const existing = photo.calibration;

  return (
    <div className={cn('flex min-h-0 flex-col gap-3 md:flex-row', className)}>
      <CalibrationViewer
        src={api.photoUrl(wall.id, photo.id)}
        image={image}
        markers={markers}
        {...(gridOverlay ? { overlay: gridOverlay } : {})}
        {...(outline ? { outlines: [outline] } : {})}
        {...(wizard
          ? {
              onPlace: (point: readonly [number, number]) => {
                if (placing) dispatch({ type: 'click', px: [point[0], point[1]] });
              },
              onMove: (index: number, point: readonly [number, number]) =>
                dispatch({ type: 'moveClick', index, px: [point[0], point[1]] }),
            }
          : {})}
        className="min-h-64 flex-1 max-md:h-[min(52dvh,26rem)] max-md:flex-none"
      />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (isMode(value)) switchTab(value);
        }}
        className="flex min-h-0 w-full flex-col gap-3 md:w-80 md:overflow-y-auto"
      >
        <TabsList className="w-full">
          <TabsTrigger value="two-point">{t('calibration.tab.twoPoint')}</TabsTrigger>
          <TabsTrigger value="corners">{t('photo.wizard.tab.corners')}</TabsTrigger>
          <TabsTrigger value="grid">{t('calibration.tab.grid')}</TabsTrigger>
        </TabsList>

        <TabsContent value="two-point" className="flex-none flex flex-col gap-3">
          <Label htmlFor="photo-wizard-length">{t('photo.wizard.reference.length')}</Label>
          <div className="flex gap-2">
            <Input
              id="photo-wizard-length"
              inputMode="decimal"
              value={lengthText}
              aria-invalid={wizard?.mode === 'two-point' && !(wizard.realMm > 0)}
              onChange={(event) => setLengthText(event.target.value)}
            />
            <UnitToggle unit={unit} onChange={changeUnit} />
          </div>
          <Label>{t('photo.wizard.axis')}</Label>
          <ToggleGroup
            aria-label={t('photo.wizard.axis')}
            variant="outline"
            size="sm"
            spacing={0}
            value={[wizard?.mode === 'two-point' ? wizard.axis : 'free']}
            onValueChange={(value) => {
              const next = value[0];
              if (isAxis(next)) dispatch({ type: 'setAxis', axis: next });
            }}
          >
            {AXES.map((axis) => (
              <ToggleGroupItem
                key={axis}
                value={axis}
                className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
              >
                {t(`photo.wizard.axis.${axis}`)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </TabsContent>

        <TabsContent value="corners" className="flex-none flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t('photo.wizard.corners.intro')}</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="photo-wizard-width">{t('photo.wizard.width')}</Label>
              <Input
                id="photo-wizard-width"
                inputMode="decimal"
                value={widthText}
                onChange={(event) => setWidthText(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="photo-wizard-height">{t('photo.wizard.height')}</Label>
              <Input
                id="photo-wizard-height"
                inputMode="decimal"
                value={heightText}
                onChange={(event) => setHeightText(event.target.value)}
              />
            </div>
          </div>
          <UnitToggle unit={unit} onChange={changeUnit} />
        </TabsContent>

        <TabsContent value="grid" className="flex-none">
          <CalibrationGrid
            state={detection.state}
            onDetect={() => void detection.start()}
            onCancel={detection.cancel}
            onAccept={() => review && apply(review.calibration)}
            onReject={detection.reset}
          />
        </TabsContent>

        {wizard ? (
          <>
            <p className="rounded-md bg-muted/60 px-3 py-2 text-sm" aria-live="polite">
              {prompt?.kind === 'click'
                ? t(`photo.wizard.prompt.${prompt.label}`)
                : t('photo.wizard.prompt.confirm')}
            </p>

            <output
              className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-sm tabular-nums"
              aria-live="polite"
            >
              {preview ? (
                <>
                  <span>
                    <strong>
                      {t('photo.wizard.scale', { value: num.format(preview.result.mmPerPx) })}
                    </strong>
                    <span className="block text-xs text-muted-foreground">
                      {t('photo.wizard.scale.per100', {
                        value: fixed.format(preview.result.mmPerPx * 100),
                      })}
                    </span>
                  </span>
                  {preview.clickError ? (
                    <span className="text-xs text-muted-foreground">
                      {t('photo.wizard.clickError', {
                        typical: percent(preview.clickError.onePx.typicalRelativeError),
                        worst: percent(preview.clickError.onePx.worstRelativeError),
                        mm: fixed.format(preview.clickError.onePx.worstMmPerMeter),
                        three: percent(preview.clickError.threePx.typicalRelativeError),
                      })}
                    </span>
                  ) : null}
                  {preview.spread ? (
                    <span className="text-xs text-muted-foreground">
                      {t('photo.wizard.spread', {
                        value: percent(preview.spread.relativeSpread, 0),
                      })}
                    </span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    {t('photo.wizard.reprojection', {
                      rms: fixed.format(preview.result.reprojection.rmsPx),
                      max: fixed.format(preview.result.reprojection.maxPx),
                      mm: fixed.format(preview.result.reprojection.maxMm),
                    })}
                  </span>
                </>
              ) : problem !== null && problem !== 'need-clicks' ? (
                <span className="text-destructive">{t(PROBLEM_KEY[problem])}</span>
              ) : (
                <span className="text-muted-foreground">{t(PROBLEM_KEY['need-clicks'])}</span>
              )}
            </output>

            {preview?.warnings.map((warning) => (
              <p key={warning} className="text-xs text-warn">
                {t(WARNING_KEY[warning])}
              </p>
            ))}

            {existing?.mmPerPx === undefined ? null : (
              <p className="text-xs text-muted-foreground">
                {t('calibration.existing', {
                  method: t(`calibration.method.${existing.method}`),
                  value: num.format(existing.mmPerPx),
                })}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!preview || !complete}
                onClick={() => {
                  if (!preview) return;
                  try {
                    apply(toCoreCalibration(preview.result));
                  } catch (failure) {
                    setError(failure instanceof Error ? failure.message : String(failure));
                  }
                }}
              >
                {t('calibration.apply')}
              </Button>
              <Button
                variant="ghost"
                disabled={wizard.clicks.length === 0}
                onClick={() => dispatch({ type: 'undo' })}
              >
                <Undo2Icon aria-hidden />
                {t('photo.wizard.undoClick')}
              </Button>
              <Button
                variant="ghost"
                disabled={wizard.clicks.length === 0}
                onClick={() => dispatch({ type: 'reset' })}
              >
                <RotateCcwIcon aria-hidden />
                {t('calibration.reset')}
              </Button>
            </div>
          </>
        ) : null}

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {t('calibration.error.apply', { message: error })}
          </p>
        ) : null}
        {onCancel ? (
          <Button variant="outline" onClick={onCancel}>
            {t('photo.wizard.cancel')}
          </Button>
        ) : null}
      </Tabs>
    </div>
  );
}

const CORNER_LABELS = ['lower-left', 'lower-right', 'upper-right', 'upper-left'] as const;

function UnitToggle({
  unit,
  onChange,
}: {
  readonly unit: LengthUnit;
  readonly onChange: (unit: LengthUnit) => void;
}) {
  const { t } = useI18n();
  return (
    <ToggleGroup
      aria-label={t('calibration.unit')}
      variant="outline"
      size="sm"
      spacing={0}
      value={[unit]}
      onValueChange={(value) => {
        const next = value[0];
        if (isUnit(next)) onChange(next);
      }}
    >
      {LENGTH_UNITS.map((value) => (
        <ToggleGroupItem
          key={value}
          value={value}
          className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
        >
          {t(`calibration.unit.${value}`)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
