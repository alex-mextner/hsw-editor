import { useMemo } from 'react';
import type { BankElement } from '@hsw-editor/bank';
import type { Wall } from '@hsw-editor/core';
import { bankStore } from '@/bank/client.ts';
import { useI18n } from '@/i18n/index.ts';
import { editorStore } from '@/state/editor.ts';
import { useStore } from '@/state/react.ts';
import { dragGuides, extentOutlinePx, toPx } from './photoGuides.ts';
import type { PhotoView } from './photoView.ts';

const EMPTY: ReadonlyMap<string, BankElement> = new Map();

/**
 * While an item is dragged over the photo: the snapped footprint (green when it fits, red when it does not) and
 * ruler lines in millimetres to the board edges and the nearest neighbours, all drawn in photo pixels.
 */
export function PhotoGuides({ wall, view }: { readonly wall: Wall; readonly view: PhotoView }) {
  const { locale } = useI18n();
  const { dragging, dragValid } = useStore(editorStore);
  const bankState = useStore(bankStore);
  const bank = bankState.status === 'ready' ? bankState.byId : EMPTY;
  const primary = dragging.keys().next().value;
  const guides = useMemo(
    () => dragGuides(wall, bank, dragging, primary),
    [wall, bank, dragging, primary],
  );
  if (!guides) return null;
  const outline = extentOutlinePx(view.map, guides.extent);
  const colour = dragValid ? '#22c55e' : '#ef4444';
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return (
    <svg
      aria-hidden
      data-photo-guides
      className="pointer-events-none absolute inset-0 z-10 size-full"
      viewBox={`0 0 ${view.image.width} ${view.image.height}`}
      preserveAspectRatio="none"
    >
      {outline ? (
        <polygon
          points={outline.map((p) => p.join(',')).join(' ')}
          fill={colour}
          fillOpacity={0.18}
          stroke={colour}
          strokeWidth={view.image.width / 500}
        />
      ) : null}
      {guides.segments.map((segment, index) => {
        const ends = toPx(view.map, [segment.from, segment.to]);
        if (!ends || segment.gapMm < 0.5) return null;
        const [a, b] = ends as [[number, number], [number, number]];
        const stroke = segment.kind === 'edge' ? '#38bdf8' : '#f59e0b';
        const size = view.image.width / 60;
        return (
          <g key={index}>
            <line
              x1={a[0]}
              y1={a[1]}
              x2={b[0]}
              y2={b[1]}
              stroke={stroke}
              strokeWidth={view.image.width / 700}
              strokeDasharray={`${size / 2} ${size / 3}`}
            />
            <text
              x={(a[0] + b[0]) / 2}
              y={(a[1] + b[1]) / 2}
              fontSize={size}
              fill="#fff"
              stroke="#000"
              strokeWidth={size / 8}
              paintOrder="stroke"
              textAnchor="middle"
            >
              {number.format(segment.gapMm)} mm
            </text>
          </g>
        );
      })}
    </svg>
  );
}
