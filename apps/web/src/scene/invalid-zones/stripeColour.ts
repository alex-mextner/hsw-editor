/**
 * Which stripe colour an invalid region gets. Red stripes vanish on a red part (a red screwdriver handle), so a region
 * that mostly covers red-ish material is striped WHITE; everything else keeps the default red. Pure maths, no three.js:
 * runs in the zone worker next to the boolean that produces the region, and under bun in tests.
 */

export type StripeColour = 'red' | 'white';

/** sRGB channels, 0..1. */
export type Rgb = readonly [number, number, number];

/** Material colour of one GLB mesh and the box it occupies in the item frame (millimetres). */
export interface ColourPart {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly rgb: Rgb;
}

/** Red-ish hue window, degrees: crimson/pink-red (>= 335) through red to red-orange (<= 30). */
const RED_HUE_FROM = 335;
const RED_HUE_TO = 30;
/** Greys, whites and near-blacks carry no usable hue; below these the red stripes read fine. */
const MIN_SATURATION = 0.35;
const MIN_VALUE = 0.2;
/** A region is white-striped when at least this share of its colour samples is red-ish. */
const WHITE_SHARE = 0.5;

/** True for colours the default red stripes would blend into. */
export function isRedish([r, g, b]: Rgb): boolean {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (max < MIN_VALUE || delta / max < MIN_SATURATION) return false;
  let hue: number;
  if (max === r) hue = 60 * ((g - b) / delta);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  return hue >= RED_HUE_FROM || hue <= RED_HUE_TO;
}

/** Stripe colour for a region given the base colour found under each of its sample points (`null` = unknown). */
export function chooseStripeColour(samples: readonly (Rgb | null)[]): StripeColour {
  let known = 0;
  let red = 0;
  for (const sample of samples) {
    if (!sample) continue;
    known += 1;
    if (isRedish(sample)) red += 1;
  }
  return known > 0 && red / known >= WHITE_SHARE ? 'white' : 'red';
}

/**
 * Base colour at an item-frame point: the part whose box contains it, else the nearest box. When several boxes tie on
 * distance the smallest wins, so a rod inside a handle's box keeps its own colour.
 */
export function colourAt(
  parts: readonly ColourPart[],
  x: number,
  y: number,
  z: number,
): Rgb | null {
  let best: ColourPart | null = null;
  let bestDistance = Infinity;
  let bestVolume = Infinity;
  for (const part of parts) {
    const dx = Math.max(part.min[0] - x, 0, x - part.max[0]);
    const dy = Math.max(part.min[1] - y, 0, y - part.max[1]);
    const dz = Math.max(part.min[2] - z, 0, z - part.max[2]);
    const distance = dx * dx + dy * dy + dz * dz;
    const volume =
      (part.max[0] - part.min[0]) * (part.max[1] - part.min[1]) * (part.max[2] - part.min[2]);
    if (distance < bestDistance || (distance === bestDistance && volume < bestVolume)) {
      best = part;
      bestDistance = distance;
      bestVolume = volume;
    }
  }
  return best ? best.rgb : null;
}
