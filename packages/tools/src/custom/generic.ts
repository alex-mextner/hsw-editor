/**
 * Generic loft model for objects with no matching class: the observed width profile becomes a smooth
 * superellipse loft along Y, split into one part per colour segment. Thickness is an input (user value,
 * fitted ratio or class-agnostic guess).
 */
import { type V2, clamp, lerp } from '../math.ts';
import { loft, type Station } from '../build/primitives.ts';
import { superellipse } from '../build/rings.ts';
import {
  boundsOfParts,
  buildHolding,
  totalTriangles,
  type Lod,
  type Part,
  type ToolModel,
} from '../model.ts';
import { materialForSample } from './colors.ts';
import { observedWidthAt } from './fit.ts';
import type { ColorSegment, ObservedProfile } from './schema.ts';

export interface GenericOptions {
  thicknessMm: number;
  /** Cross-section sharpness: 2 ellipse, 4 soft rectangle (flat tools), default 3. */
  exponent?: number;
  colors?: readonly ColorSegment[];
  roleGuess?: (segmentIndex: number) => string | undefined;
}

function centreAt(profile: ObservedProfile, t: number): number {
  const st = profile.stations;
  const first = st[0];
  if (first && t < first.t) return (first.lo + first.hi) / 2;
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i];
    const b = st[i + 1];
    if (a && b && t >= a.t && t <= b.t) {
      const u = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
      return lerp((a.lo + a.hi) / 2, (b.lo + b.hi) / 2, u);
    }
  }
  const l = st[st.length - 1];
  return l ? (l.lo + l.hi) / 2 : 0;
}

export const GENERIC_CLASS_ID = 'generic-loft';

export function buildGenericLoft(
  profile: ObservedProfile,
  options: GenericOptions,
  lod: Lod,
  name = 'generic object',
): ToolModel {
  const ringN = lod === 0 ? 48 : 24;
  const steps = lod === 0 ? 48 : 20;
  const wmax = Math.max(...profile.stations.map((s) => s.hi - s.lo), 1e-6);
  const exponent = options.exponent ?? 3;
  const colors =
    options.colors && options.colors.length > 0
      ? [...options.colors].sort((a, b) => a.t0 - b.t0)
      : [{ t0: 0, t1: 1, hex: '#6c7077', weight: 1 }];

  const ringAt = (t: number): V2[] => {
    const w = Math.max(observedWidthAt(profile, t), 0.8);
    const th = clamp(
      options.thicknessMm * (w / wmax) ** 0.6,
      0.8,
      Math.max(options.thicknessMm, 0.8),
    );
    const cx = centreAt(profile, t);
    return superellipse(w / 2, th / 2, exponent, ringN).map(([x, z]) => [x + cx, z]);
  };

  const parts: Part[] = colors.map((seg, i) => {
    const t0 = clamp(seg.t0, 0, 1);
    const t1 = clamp(seg.t1, t0 + 1e-3, 1);
    const n = Math.max(3, Math.round(steps * (t1 - t0)));
    const stations: Station[] = [];
    for (let k = 0; k <= n; k++) {
      const t = lerp(t0, t1, k / n);
      stations.push({ y: t * profile.lengthMm, ring: ringAt(t) });
    }
    const roleGuess = options.roleGuess?.(i);
    return {
      name: `segment-${i + 1}`,
      role: roleGuess ?? 'body',
      material: materialForSample(seg.hex, roleGuess),
      mesh: loft(stations),
      crease: 45,
    };
  });

  const bounds = boundsOfParts(parts);
  return {
    classId: GENERIC_CLASS_ID,
    params: { name },
    lod,
    parts,
    bounds,
    holding: buildHolding(
      {
        parts,
        zones: [{ name: 'body', y0: 0, y1: profile.lengthMm }],
        dims: { length: profile.lengthMm, width: wmax, thickness: options.thicknessMm },
      },
      bounds,
      lod === 0 ? 2 : 4,
    ),
    triangles: totalTriangles(parts),
  };
}
