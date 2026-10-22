import { LoaderCircleIcon, ScanSearchIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.tsx';
import { useI18n } from '@/i18n/index.ts';
import type { DetectState } from './calibrationDetect.ts';

interface CalibrationGridProps {
  readonly state: DetectState;
  readonly onDetect: () => void;
  readonly onCancel: () => void;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

/** Side panel of the grid method: run the detector, then review its fit before anything is applied. */
export function CalibrationGrid({
  state,
  onDetect,
  onCancel,
  onAccept,
  onReject,
}: CalibrationGridProps) {
  const { t, tn, locale } = useI18n();
  const number = new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 });

  if (state.phase === 'running') {
    const fraction = state.progress?.fraction;
    return (
      <div className="flex flex-col gap-3" aria-live="polite">
        <p className="flex items-center gap-2 text-sm">
          <LoaderCircleIcon
            className="size-4 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
          {state.progress?.message ?? t('calibration.grid.running')}
        </p>
        {fraction === undefined ? null : (
          <>
            <progress
              className="sr-only"
              aria-label={t('calibration.grid.running')}
              max={100}
              value={Math.round(fraction * 100)}
            />
            <div aria-hidden className="h-1.5 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary" style={{ width: `${fraction * 100}%` }} />
            </div>
          </>
        )}
        <Button variant="outline" onClick={onCancel}>
          {t('calibration.grid.cancel')}
        </Button>
      </div>
    );
  }

  if (state.phase === 'review') {
    const { result } = state;
    const rows: readonly (readonly [string, string])[] = [
      ...(result.reprojErrorPx === undefined
        ? []
        : [
            [
              t('calibration.grid.reproj'),
              `${number.format(result.reprojErrorPx)} ${t('calibration.px')}`,
            ] as const,
          ]),
      ...(result.focalPx === undefined
        ? []
        : [
            [
              t('calibration.grid.focal'),
              `${number.format(result.focalPx)} ${t('calibration.px')}`,
            ] as const,
          ]),
      ...(result.mmPerPx === undefined
        ? []
        : [[t('calibration.mmPerPx'), number.format(result.mmPerPx)] as const]),
    ];
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">{t('calibration.grid.review')}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm tabular-nums">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
          {result.points === undefined ? null : (
            <div className="contents">
              <dt className="text-muted-foreground">{t('calibration.grid.points')}</dt>
              <dd>{tn('calibration.grid.pointCount', result.points.length)}</dd>
            </div>
          )}
        </dl>
        <div className="flex gap-2">
          <Button onClick={onAccept}>{t('calibration.grid.accept')}</Button>
          <Button variant="ghost" onClick={onReject}>
            {t('calibration.grid.reject')}
          </Button>
        </div>
      </div>
    );
  }

  const problem =
    state.phase === 'unavailable'
      ? t('calibration.grid.unavailable')
      : state.phase === 'failed'
        ? state.message === null
          ? t('calibration.grid.failed')
          : t('calibration.grid.failedWith', { message: state.message })
        : null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">{t('calibration.grid.intro')}</p>
      {problem ? (
        <p
          role="alert"
          className={
            state.phase === 'unavailable' ? 'text-sm text-warn' : 'text-sm text-destructive'
          }
        >
          {problem}
        </p>
      ) : null}
      <Button onClick={onDetect}>
        <ScanSearchIcon aria-hidden />
        {t(problem ? 'calibration.grid.retry' : 'calibration.grid.detect')}
      </Button>
    </div>
  );
}
