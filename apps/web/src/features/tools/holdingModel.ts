/**
 * Geometry of the holding-interface diagram: what a holder has to fit, drawn along the tool axis. Two stacked
 * silhouettes (width seen from the front, thickness seen from the side), the named zones as bands, the hang
 * point and the widest section. Pure (no React): the SVG component only paints these shapes.
 */
import type { HoldingResponse } from './api.ts';

type Holding = HoldingResponse['holding'];
type HangKind = NonNullable<Holding['hang']>['kind'];

export interface DiagramLayout {
  readonly width: number;
  readonly height: number;
  readonly padding: number;
}

export interface Band {
  readonly name: string;
  readonly x: number;
  readonly width: number;
}

export interface Silhouette {
  /** Closed polygon, SVG `points` format. */
  readonly points: string;
  /** Vertical centre line of the silhouette. */
  readonly axisY: number;
  /** Half of the drawing height reserved for it. */
  readonly halfHeight: number;
}

export interface Tick {
  readonly x: number;
  readonly label: string;
}

export interface HoldingDiagramModel {
  readonly bands: readonly Band[];
  readonly front: Silhouette;
  readonly side: Silhouette;
  readonly hang: { readonly x: number; readonly kind: HangKind } | null;
  readonly widest: { readonly x: number; readonly label: string };
  readonly ticks: readonly Tick[];
  /** Pixels per millimetre along the axis. */
  readonly scale: number;
  readonly lengthMm: number;
}

/** Round step (1, 2, 5 x 10^n mm) that gives roughly `target` ticks over `lengthMm`. */
export function tickStep(lengthMm: number, target = 6): number {
  const raw = lengthMm / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10;
  return nice * power;
}

function silhouette(
  samples: Holding['profile']['samples'],
  extent: 'w' | 't',
  x: (y: number) => number,
  axisY: number,
  halfHeight: number,
  perMm: number,
): Silhouette {
  const top = samples.map((sample) => `${x(sample.y).toFixed(1)},${(axisY - (sample[extent] / 2) * perMm).toFixed(1)}`);
  const bottom = samples
    .slice()
    .reverse()
    .map((sample) => `${x(sample.y).toFixed(1)},${(axisY + (sample[extent] / 2) * perMm).toFixed(1)}`);
  return { points: [...top, ...bottom].join(' '), axisY, halfHeight };
}

/**
 * Lays the holding interface out in `layout`. The silhouettes share one scale (the widest section fits its
 * half) so widths and thicknesses are comparable; the axis scale follows the tool length.
 */
export function diagramModel(holding: Holding, layout: DiagramLayout): HoldingDiagramModel {
  const { samples } = holding.profile;
  const first = samples[0]?.y ?? 0;
  const last = samples[samples.length - 1]?.y ?? holding.lengthMm;
  const span = Math.max(last - first, 1);
  const innerWidth = layout.width - 2 * layout.padding;
  const scale = innerWidth / span;
  const x = (y: number): number => layout.padding + (y - first) * scale;

  const half = (layout.height - 2 * layout.padding) / 4;
  const widest = Math.max(holding.maxSection.w, holding.maxSection.t, 1);
  const perMm = Math.min(scale, half / (widest / 2));
  const frontAxis = layout.padding + half;
  const sideAxis = layout.padding + 3 * half;

  const step = tickStep(span);
  const ticks: Tick[] = [];
  for (let mm = Math.ceil(first / step) * step; mm <= last + 1e-6; mm += step) {
    ticks.push({ x: x(mm), label: `${Math.round(mm)}` });
  }

  return {
    bands: holding.zones.map((zone) => ({
      name: zone.name,
      x: x(zone.y0),
      width: Math.max((zone.y1 - zone.y0) * scale, 0),
    })),
    front: silhouette(samples, 'w', x, frontAxis, half, perMm),
    side: silhouette(samples, 't', x, sideAxis, half, perMm),
    hang: holding.hang ? { x: x(holding.hang.point[1]), kind: holding.hang.kind } : null,
    widest: {
      x: x(holding.maxSection.y),
      label: `${holding.maxSection.w.toFixed(0)} × ${holding.maxSection.t.toFixed(0)}`,
    },
    ticks,
    scale,
    lengthMm: holding.lengthMm,
  };
}
