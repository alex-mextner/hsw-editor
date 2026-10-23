/**
 * Photo colours onto model parts. The sidecar returns colour segments along the observed axis; each part
 * of the fitted model takes the colour of the segment that overlaps its Y range the most (a part is one
 * material, so the dominant colour wins instead of a muddy average). Metals keep their finish and only
 * switch to black oxide when the photo shows a dark metal.
 */
import { hexToRgb, METALS, type Material, rgbToHex } from '../materials.ts';
import { type Part, type ToolModel } from '../model.ts';
import { boundsOf } from '../mesh.ts';
import type { ColorSegment } from './schema.ts';

const SKIP_KINDS: ReadonlySet<Material['kind']> = new Set(['glass', 'paper']);

const luminance = (hex: string): number => {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** Apply an explicit colour to a material: metals stay metals (dark photo colour = black oxide). */
export function recolorMaterial(material: Material, hex: string): Material {
  if (SKIP_KINDS.has(material.kind)) return material;
  if (material.kind === 'metal') {
    return luminance(hex) < 0.2 ? METALS.blackOxide : material;
  }
  return { ...material, color: hex };
}

/** Segment (by overlap with the part's normalised Y range) giving the part its colour, if any. */
export function segmentColorForRange(
  segments: readonly ColorSegment[],
  u0: number,
  u1: number,
  flipped: boolean,
): string | null {
  const a = flipped ? 1 - u1 : u0;
  const b = flipped ? 1 - u0 : u1;
  let best: ColorSegment | null = null;
  let bestOverlap = 0;
  for (const seg of segments) {
    const overlap = Math.min(b, Math.max(seg.t0, seg.t1)) - Math.max(a, Math.min(seg.t0, seg.t1));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = seg;
    }
  }
  return best ? best.hex : null;
}

/** Colour per part name from colour segments of the photo. */
export function colorsFromSegments(
  model: ToolModel,
  segments: readonly ColorSegment[],
  flipped: boolean,
): Record<string, string> {
  const y0 = model.bounds.min[1];
  const len = Math.max(model.bounds.max[1] - y0, 1e-6);
  const out: Record<string, string> = {};
  for (const part of model.parts) {
    if (SKIP_KINDS.has(part.material.kind)) continue;
    const b = boundsOf(part.mesh);
    const hex = segmentColorForRange(
      segments,
      (b.min[1] - y0) / len,
      (b.max[1] - y0) / len,
      flipped,
    );
    if (hex) out[part.name] = hex;
  }
  return out;
}

export function recolorModel(
  model: ToolModel,
  partColors: Readonly<Record<string, string>>,
): ToolModel {
  const parts: Part[] = model.parts.map((p) => {
    const hex = partColors[p.name];
    return hex ? { ...p, material: recolorMaterial(p.material, hex) } : p;
  });
  return { ...model, parts };
}

/** Material for a photo-sampled colour on an unknown (generic) part. */
export function materialForSample(hex: string, roleGuess?: string): Material {
  const [r, g, b] = hexToRgb(hex);
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  const lum = luminance(hex);
  const metalRole = roleGuess === 'metal' || roleGuess === 'shaft' || roleGuess === 'blade';
  if (metalRole || (sat < 0.12 && lum > 0.45 && lum < 0.85 && roleGuess !== 'plastic')) {
    return { ...METALS.steel, color: rgbToHex(r, g, b) };
  }
  const rubberLike = lum < 0.18 || roleGuess === 'grip' || roleGuess === 'rubber';
  return {
    name: rubberLike ? 'sampled rubber' : 'sampled plastic',
    kind: rubberLike ? 'rubber' : 'plastic',
    color: hex,
    metallic: 0,
    roughness: rubberLike ? 0.8 : 0.42,
    alpha: 1,
    ...(rubberLike ? { grip: 'soft-grip' as const } : {}),
  };
}
