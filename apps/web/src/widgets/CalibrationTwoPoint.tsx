import { RotateCcwIcon } from 'lucide-react';
import type { Calibration } from '@hsw-editor/core';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group.tsx';
import { useI18n } from '@/i18n/index.ts';
import {
  LENGTH_UNITS,
  parseLength,
  toMillimetres,
  twoPointScale,
  type LengthUnit,
  type Point2,
} from './calibrationMath.ts';

interface CalibrationTwoPointProps {
  readonly points: readonly Point2[];
  readonly distanceText: string;
  readonly unit: LengthUnit;
  readonly existing: Calibration | undefined;
  readonly onDistance: (text: string) => void;
  readonly onUnit: (unit: LengthUnit) => void;
  readonly onReset: () => void;
  readonly onApply: () => void;
}

function isUnit(value: unknown): value is LengthUnit {
  return LENGTH_UNITS.some((unit) => unit === value);
}

/** Side panel of the two-point method: instructions, the real distance, the live scale and Apply. */
export function CalibrationTwoPoint({
  points,
  distanceText,
  unit,
  existing,
  onDistance,
  onUnit,
  onReset,
  onApply,
}: CalibrationTwoPointProps) {
  const { t, locale } = useI18n();
  const [a, b] = points;
  const length = parseLength(distanceText);
  const scale = a && b && length !== null ? twoPointScale(a, b, toMillimetres(length, unit)) : null;
  const mmPerPx = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });
  const step = a ? (b ? 'enter' : 'second') : 'first';

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t(`calibration.step.${step}`)}</p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="calibration-distance">{t('calibration.distance')}</Label>
        <div className="flex gap-2">
          <Input
            id="calibration-distance"
            inputMode="decimal"
            value={distanceText}
            placeholder={t('calibration.distance.placeholder')}
            disabled={!b}
            aria-invalid={distanceText.trim() !== '' && length === null}
            onChange={(event) => onDistance(event.target.value)}
          />
          <ToggleGroup
            aria-label={t('calibration.unit')}
            variant="outline"
            size="sm"
            spacing={0}
            value={[unit]}
            onValueChange={(value) => {
              const next = value[0];
              if (isUnit(next)) onUnit(next);
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
        </div>
      </div>

      <output className="rounded-md bg-muted/60 px-3 py-2 text-sm" aria-live="polite">
        {scale?.ok ? (
          <span className="tabular-nums">
            <strong>{mmPerPx.format(scale.mmPerPx)}</strong> {t('calibration.mmPerPx')}
            <span className="block text-xs text-muted-foreground">
              {t('calibration.pixels', { value: mmPerPx.format(scale.pixels) })}
            </span>
          </span>
        ) : scale ? (
          <span className="text-destructive">{t(`calibration.error.${scale.reason}`)}</span>
        ) : (
          <span className="text-muted-foreground">{t('calibration.scale.pending')}</span>
        )}
      </output>

      {existing?.mmPerPx === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {t('calibration.existing', {
            method: t(`calibration.method.${existing.method}`),
            value: mmPerPx.format(existing.mmPerPx),
          })}
        </p>
      )}

      <div className="flex gap-2">
        <Button onClick={onApply} disabled={!scale?.ok}>
          {t('calibration.apply')}
        </Button>
        <Button variant="ghost" onClick={onReset} disabled={points.length === 0}>
          <RotateCcwIcon aria-hidden />
          {t('calibration.reset')}
        </Button>
      </div>
    </div>
  );
}
