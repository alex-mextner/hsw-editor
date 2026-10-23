import { useMemo } from 'react';
import { useI18n } from '@/i18n/index.ts';
import type { HoldingResponse } from './api.ts';
import { diagramModel } from './holdingModel.ts';

const LAYOUT = { width: 320, height: 170, padding: 12 } as const;
const BAND_FILLS = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#f472b6'] as const;

/**
 * The part of a tool a holder has to fit: width (top) and thickness (bottom) silhouettes along the axis,
 * the named zones as bands, the hang point and the widest section, with a millimetre ruler.
 */
export function HoldingDiagram({ holding }: { readonly holding: HoldingResponse['holding'] }) {
  const { t } = useI18n();
  const model = useMemo(() => diagramModel(holding, LAYOUT), [holding]);
  const bottom = LAYOUT.height - 2;
  return (
    <figure className="m-0 grid gap-1" data-testid="holding-diagram">
      <svg
        viewBox={`0 0 ${LAYOUT.width} ${LAYOUT.height}`}
        aria-labelledby="holding-diagram-title"
        className="w-full rounded-md border border-border bg-muted/30"
      >
        <title id="holding-diagram-title">{t('toolDetail.holding.diagramLabel')}</title>
        {model.bands.map((band, index) => (
          <g key={band.name}>
            <rect
              x={band.x}
              y={LAYOUT.padding / 2}
              width={band.width}
              height={LAYOUT.height - LAYOUT.padding - 12}
              fill={BAND_FILLS[index % BAND_FILLS.length]}
              opacity={0.12}
            />
            <text
              x={band.x + band.width / 2}
              y={LAYOUT.padding / 2 + 8}
              textAnchor="middle"
              fontSize={8}
              className="fill-muted-foreground"
            >
              {band.name}
            </text>
          </g>
        ))}
        {[model.front, model.side].map((shape) => (
          <g key={shape.axisY}>
            <line
              x1={LAYOUT.padding}
              x2={LAYOUT.width - LAYOUT.padding}
              y1={shape.axisY}
              y2={shape.axisY}
              strokeDasharray="3 3"
              className="stroke-border"
            />
            <polygon
              points={shape.points}
              className="fill-primary/25 stroke-primary"
              strokeWidth={1}
              strokeLinejoin="round"
            />
          </g>
        ))}
        <line
          x1={model.widest.x}
          x2={model.widest.x}
          y1={LAYOUT.padding / 2}
          y2={bottom - 12}
          strokeDasharray="2 2"
          className="stroke-warn"
        />
        <text x={model.widest.x + 3} y={bottom - 14} fontSize={8} className="fill-warn">
          {t('toolDetail.holding.widest', { size: model.widest.label })}
        </text>
        {model.hang ? (
          <g>
            <circle
              cx={model.hang.x}
              cy={model.front.axisY}
              r={4}
              className="fill-destructive stroke-background"
              strokeWidth={1.5}
            />
            <text
              x={model.hang.x + 7}
              y={model.front.axisY - 6}
              fontSize={8}
              className="fill-destructive"
            >
              {t(`toolDetail.holding.hang.${model.hang.kind}`)}
            </text>
          </g>
        ) : null}
        {model.ticks.map((tick) => (
          <g key={tick.label}>
            <line x1={tick.x} x2={tick.x} y1={bottom - 9} y2={bottom - 5} className="stroke-muted-foreground" />
            <text x={tick.x} y={bottom} fontSize={7} textAnchor="middle" className="fill-muted-foreground">
              {tick.label}
            </text>
          </g>
        ))}
      </svg>
      <figcaption className="text-[11px] text-muted-foreground">
        {t('toolDetail.holding.caption', { length: Math.round(model.lengthMm) })}
      </figcaption>
    </figure>
  );
}
