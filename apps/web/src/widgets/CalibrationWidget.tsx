import { useState } from 'react';
import type { Calibration } from '@hsw-editor/core';
import { api } from '@/api/http.ts';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs.tsx';
import { useT } from '@/i18n/index.ts';
import { useStore } from '@/state/react.ts';
import { sessionStore, submitOps } from '@/wall/session.ts';
import { CalibrationGrid } from './CalibrationGrid.tsx';
import { CalibrationTwoPoint } from './CalibrationTwoPoint.tsx';
import { CalibrationViewer, type Marker } from './CalibrationViewer.tsx';
import { useGridDetection } from './calibrationDetect.ts';
import {
  parseLength,
  toMillimetres,
  twoPointCalibration,
  type LengthUnit,
  type Point2,
} from './calibrationMath.ts';

export type CalibrationMode = 'two-point' | 'grid';

export interface CalibrationOutcome {
  readonly method: Calibration['method'];
}

interface CalibrationWidgetProps {
  readonly photoId: string;
  readonly mode: CalibrationMode;
  readonly onDone: (outcome: CalibrationOutcome) => void;
}

const POINT_LABELS = ['A', 'B'] as const;

function isMode(value: unknown): value is CalibrationMode {
  return value === 'two-point' || value === 'grid';
}

/** Calibrates a wall photo: two picked points plus a known distance, or the detected honeycomb grid. */
export function CalibrationWidget({ photoId, mode, onDone }: CalibrationWidgetProps) {
  const t = useT();
  const wall = useStore(sessionStore)?.wall ?? null;
  const photo = wall?.photos.find((entry) => entry.id === photoId);
  const [tab, setTab] = useState<CalibrationMode>(mode);
  const [points, setPoints] = useState<readonly Point2[]>([]);
  const [distanceText, setDistanceText] = useState('');
  const [unit, setUnit] = useState<LengthUnit>('mm');
  const [error, setError] = useState<string | null>(null);
  const detection = useGridDetection(wall?.id ?? '', photoId);

  const image = photo ? { width: photo.width, height: photo.height } : null;

  if (!wall || !photo || !image) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t('calibration.noPhoto')}
      </p>
    );
  }

  function apply(calibration: Calibration | null): void {
    if (!calibration) return;
    const result = submitOps([{ type: 'setCalibration', photoId, calibration }], 'calibrate');
    if (result.ok) onDone({ method: calibration.method });
    else setError(result.error.message);
  }

  function applyTwoPoint(): void {
    const [a, b] = points;
    const length = parseLength(distanceText);
    if (!a || !b || length === null) return;
    apply(twoPointCalibration(a, b, toMillimetres(length, unit)));
  }

  const markers: readonly Marker[] =
    tab === 'two-point'
      ? points.flatMap((point, index) => {
          const label = POINT_LABELS[index];
          return label === undefined ? [] : [{ point, label }];
        })
      : [];
  const review = detection.state.phase === 'review' ? detection.state : null;
  const overlay = review?.result.points?.map((entry) => entry.px);

  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        if (isMode(value)) setTab(value);
      }}
    >
      <TabsList>
        <TabsTrigger value="two-point">{t('calibration.tab.twoPoint')}</TabsTrigger>
        <TabsTrigger value="grid">{t('calibration.tab.grid')}</TabsTrigger>
      </TabsList>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_18rem]">
        <CalibrationViewer
          src={api.photoUrl(wall.id, photo.id)}
          image={image}
          markers={markers}
          {...(overlay ? { overlay } : {})}
          {...(tab === 'two-point'
            ? {
                // A third click restarts the pair instead of silently doing nothing.
                onPlace: (point: Point2) =>
                  setPoints(points.length >= 2 ? [point] : [...points, point]),
                onMove: (index: number, point: Point2) =>
                  setPoints(points.map((existing, i) => (i === index ? point : existing))),
              }
            : {})}
          className="h-[min(55dvh,28rem)] min-h-64"
        />
        <TabsContent value="two-point">
          <CalibrationTwoPoint
            points={points}
            distanceText={distanceText}
            unit={unit}
            existing={photo.calibration}
            onDistance={setDistanceText}
            onUnit={setUnit}
            onReset={() => setPoints([])}
            onApply={applyTwoPoint}
          />
        </TabsContent>
        <TabsContent value="grid">
          <CalibrationGrid
            state={detection.state}
            onDetect={() => void detection.start()}
            onCancel={detection.cancel}
            onAccept={() => apply(review?.calibration ?? null)}
            onReject={detection.reset}
          />
        </TabsContent>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t('calibration.error.apply', { message: error })}
        </p>
      ) : null}
    </Tabs>
  );
}
