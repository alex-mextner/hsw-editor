/**
 * How the white honeycomb web is drawn over a photo so it stays readable on a white wall: a dark hairline along
 * every hole edge and a slightly shaded plate. `auto` turns the treatment on when the wall behind the board is
 * about as bright as the plate itself; `on` / `off` are the user's override (`WebContrastMode`).
 */
import type { WebContrastMode } from '@/state/photo.ts';

export interface WebStyle {
  /** Plate colour. */
  readonly fill: string;
  /** Hairline along the hole edges; null = no outline. */
  readonly edge: string | null;
  /** Full width of the hairline, centred on the hole edge (only the half on the plate shows). */
  readonly edgeMm: number;
}

/** Plain plate: the panel is white plastic. */
export const PLAIN_WEB: WebStyle = { fill: '#f3f3ef', edge: null, edgeMm: 0 };

/** Plate that holds its own against a white wall. */
export const CONTRAST_WEB: WebStyle = {
  fill: '#dfdfd9',
  edge: 'rgba(48, 52, 60, 0.7)',
  edgeMm: 1.2,
};

/**
 * Mean wall luma from which the plain plate (luma ~0.95) no longer stands out from the wall seen through its cells:
 * a plate-to-wall step under about a third of the range is hard to read, and a cream wall in a phone photo is ~0.7.
 */
export const BRIGHT_WALL_LUMA = 0.65;

/** Relative luma 0..1 of an sRGB colour with 0..255 channels (Rec. 709 weights on the encoded values). */
export function lumaOf(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Mean luma of RGBA pixel data, ignoring transparent pixels; null when nothing is opaque. */
export function meanLuma(rgba: Uint8ClampedArray): number | null {
  let sum = 0;
  let count = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < 128) continue;
    sum += lumaOf(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
    count += 1;
  }
  return count === 0 ? null : sum / count;
}

/** The web style for `mode` over a wall of mean luma `backdropLuma` (null: no photo behind the board). */
export function webStyle(mode: WebContrastMode, backdropLuma: number | null): WebStyle {
  if (mode === 'on') return CONTRAST_WEB;
  if (mode === 'off') return PLAIN_WEB;
  return backdropLuma !== null && backdropLuma >= BRIGHT_WALL_LUMA ? CONTRAST_WEB : PLAIN_WEB;
}
