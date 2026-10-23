import { useState } from 'react';
import { RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n } from '@/i18n/index.ts';
import { CalibrationViewer, type Marker } from '@/widgets/CalibrationViewer.tsx';
import type { Point2 } from '@/widgets/calibrationView.ts';
import {
  isLengthUnit,
  LENGTH_UNITS,
  parseLength,
  parseNumber,
  type LengthUnit,
} from '@/widgets/units.ts';
import { useImageSize } from './useImageSize.ts';
import { AUTO_SCALE, type ScaleChoice } from './wizardModel.ts';

type Method = ScaleChoice['kind'];

const POINT_LABELS = ['A', 'B'] as const;
/** Two picks closer than this are one click, not a measurement. */
const MIN_SEPARATION_PX = 2;

function isMethod(value: unknown): value is Method {
  return value === 'auto' || value === 'twoPoint' || value === 'mmPerPx';
}

interface ScaleReferenceProps {
  /** The chosen scale; null while the selected method is not complete yet (no points, no number). */
  readonly scale: ScaleChoice | null;
  readonly onChange: (scale: ScaleChoice | null) => void;
  /** Blob URL of the first photo: the two points are picked on it. */
  readonly photoUrl: string | null;
}

/**
 * The scale reference of the photos: the honeycomb grid (detected by the server), two points on the first photo
 * with their real distance, or a known mm per pixel. Dimensions of the tools come from this scale.
 */
export function ScaleReference({ scale, onChange, photoUrl }: ScaleReferenceProps) {
  const { t, locale } = useI18n();
  const image = useImageSize(photoUrl);
  const [method, setMethod] = useState<Method>(scale?.kind ?? 'auto');
  const [points, setPoints] = useState<readonly Point2[]>([]);
  const [distanceText, setDistanceText] = useState('');
  const [unit, setUnit] = useState<LengthUnit>('mm');
  const [mmPerPxText, setMmPerPxText] = useState('');
  const [applied, setApplied] = useState<ScaleChoice | null>(
    scale?.kind === 'twoPoint' ? scale : null,
  );
  const format = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });

  const markers: readonly Marker[] = points.flatMap((point, index) => {
    const label = POINT_LABELS[index];
    return label === undefined ? [] : [{ point, label }];
  });
  const [a, b] = points;
  const distanceMm = parseLength(distanceText, unit);
  const pixels = a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null;
  const ready =
    a !== undefined &&
    b !== undefined &&
    distanceMm !== null &&
    distanceMm > 0 &&
    pixels !== null &&
    pixels >= MIN_SEPARATION_PX;
  const mmPerPx = parseNumber(mmPerPxText);
  const step = a ? (b ? 'enter' : 'second') : 'first';

  const applyTwoPoint = (): void => {
    if (!ready) return;
    const choice: ScaleChoice = {
      kind: 'twoPoint',
      pointsPx: [
        [a[0], a[1]],
        [b[0], b[1]],
      ],
      distanceMm,
    };
    setApplied(choice);
    onChange(choice);
  };

  return (
    <Tabs
      value={method}
      onValueChange={(value) => {
        if (!isMethod(value)) return;
        setMethod(value);
        if (value === 'auto') onChange(AUTO_SCALE);
        else if (value === 'mmPerPx')
          onChange(mmPerPx === null || mmPerPx <= 0 ? null : { kind: 'mmPerPx', mmPerPx });
        else onChange(applied);
      }}
      data-testid="scale-reference"
    >
      <TabsList>
        <TabsTrigger value="auto">{t('toolWizard.scale.auto')}</TabsTrigger>
        <TabsTrigger value="twoPoint">{t('toolWizard.scale.twoPoint')}</TabsTrigger>
        <TabsTrigger value="mmPerPx">{t('toolWizard.scale.mmPerPx')}</TabsTrigger>
      </TabsList>
      <TabsContent value="auto">
        <p className="text-xs text-muted-foreground">{t('toolWizard.scale.autoHint')}</p>
      </TabsContent>
      <TabsContent value="twoPoint">
        {photoUrl === null ? (
          <p className="text-xs text-muted-foreground">{t('toolWizard.scale.needPhoto')}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_16rem]">
            {image === null ? (
              <div className="h-56 animate-pulse rounded-md bg-muted" />
            ) : (
              <CalibrationViewer
                src={photoUrl}
                image={image}
                markers={markers}
                onPlace={(point) => setPoints(points.length >= 2 ? [point] : [...points, point])}
                onMove={(index, point) =>
                  setPoints(points.map((existing, i) => (i === index ? point : existing)))
                }
                className="h-56"
              />
            )}
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{t(`toolWizard.scale.step.${step}`)}</p>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tool-wizard-distance">{t('toolWizard.scale.distance')}</Label>
                <div className="flex gap-2">
                  <Input
                    id="tool-wizard-distance"
                    inputMode="decimal"
                    value={distanceText}
                    disabled={!b}
                    aria-invalid={distanceText.trim() !== '' && distanceMm === null}
                    onChange={(event) => setDistanceText(event.target.value)}
                  />
                  <ToggleGroup
                    aria-label={t('toolWizard.scale.unit')}
                    variant="outline"
                    size="sm"
                    spacing={0}
                    value={[unit]}
                    onValueChange={(next) => {
                      const [chosen] = next;
                      if (chosen !== undefined && isLengthUnit(chosen)) setUnit(chosen);
                    }}
                  >
                    {LENGTH_UNITS.map((value) => (
                      <ToggleGroupItem key={value} value={value}>
                        {value}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={applyTwoPoint} disabled={!ready} data-testid="scale-apply">
                  {t('toolWizard.scale.apply')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setPoints([])}
                  disabled={points.length === 0}
                >
                  <RotateCcwIcon aria-hidden />
                  {t('toolWizard.scale.reset')}
                </Button>
              </div>
            </div>
          </div>
        )}
        {applied?.kind === 'twoPoint' ? (
          <p className="mt-2 text-xs text-ok" data-testid="scale-applied">
            {t('toolWizard.scale.applied', {
              value: format.format(
                applied.distanceMm /
                  Math.hypot(
                    applied.pointsPx[0][0] - applied.pointsPx[1][0],
                    applied.pointsPx[0][1] - applied.pointsPx[1][1],
                  ),
              ),
            })}
          </p>
        ) : null}
      </TabsContent>
      <TabsContent value="mmPerPx">
        <div className="grid max-w-xs gap-1.5">
          <Label htmlFor="tool-wizard-mmpx">{t('toolWizard.scale.mmPerPxLabel')}</Label>
          <Input
            id="tool-wizard-mmpx"
            inputMode="decimal"
            value={mmPerPxText}
            placeholder="0.25"
            aria-invalid={mmPerPxText.trim() !== '' && (mmPerPx === null || mmPerPx <= 0)}
            onChange={(event) => {
              setMmPerPxText(event.target.value);
              const next = parseNumber(event.target.value);
              onChange(next === null || next <= 0 ? null : { kind: 'mmPerPx', mmPerPx: next });
            }}
          />
          <p className="text-xs text-muted-foreground">{t('toolWizard.scale.mmPerPxHint')}</p>
        </div>
      </TabsContent>
    </Tabs>
  );
}
