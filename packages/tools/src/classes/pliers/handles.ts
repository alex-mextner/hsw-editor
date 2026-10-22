/**
 * Plier handles: PVC-dipped sleeves (oval section, finger grooves, flared finger-guard lip), two-component
 * grips (coloured sleeve with ribbed inserts) and bare steel bars. Handle spines run from the butt (s = 0)
 * to the head end.
 */
import type { V2 } from '../../math.ts';
import { extrude } from '../../build/primitives.ts';
import type { BuildCtx } from '../../registry.ts';
import { type Mesh } from '../../mesh.ts';
import { type Spine, bandOutline, capFactor, makeSpine, sleeveMesh } from './kit.ts';

export type HandleStyle = 'dipped' | 'comfort' | 'bare';
export const HANDLE_STYLES = ['dipped', 'comfort', 'bare'] as const;

export interface HandleSpec {
  /** Spine control points, butt first. */
  ctrl: readonly V2[];
  /** Half width in the plan plane and half thickness (z) of the sleeve. */
  hw: number;
  hz: number;
  style: HandleStyle;
  /** Finger grooves per handle (dipped / comfort), 0 for none. */
  grooves?: number;
  /** Outward flare of the finger-guard lip at the head end, mm. */
  lip?: number;
  /** Butt end taper: width factor at the butt. */
  buttTaper?: number;
}

export interface HandleResult {
  spine: Spine;
  sleeve: Mesh | null;
  inserts: Mesh[];
  bare: Mesh | null;
}

export function buildHandle(spec: HandleSpec, ctx: BuildCtx): HandleResult {
  const spine = makeSpine(spec.ctrl, 14);
  const S = spine.length;
  if (spec.style === 'bare') {
    const hwBar = spec.hw * 0.78;
    const outline = bandOutline(
      spine,
      0,
      S,
      (s) => hwBar * (0.92 + 0.08 * Math.min(1, s / 20)),
      28,
    );
    return {
      spine,
      sleeve: null,
      inserts: [],
      bare: extrude(outline, -spec.hz * 0.36, spec.hz * 0.36, { bevel: 0.9 }),
    };
  }
  const grooves = ctx.detail ? (spec.grooves ?? 0) : 0;
  const lip = spec.lip ?? 0;
  const taper = spec.buttTaper ?? 0.92;
  const groove = (s: number): number => {
    let g = 0;
    for (let i = 0; i < grooves; i++) {
      const c = S * (0.34 + (0.46 * i) / Math.max(1, grooves - 1));
      const d = (s - c) / 3.1;
      g += 0.055 * Math.exp(-d * d);
    }
    return g;
  };
  const shape = (s: number): readonly [number, number] => {
    const u = s / S;
    const cap = capFactor(s, S, spec.hz * 1.1, 2.6);
    const widthF = taper + (1 - taper) * Math.min(1, u * 2.2);
    const lipF = lip > 0 ? 1 + (lip / spec.hw) * Math.exp(-(((S - 6 - s) / 4.5) ** 2)) : 1;
    const g = 1 - groove(s);
    return [spec.hz * cap * g * (1 + (lipF - 1) * 0.5), spec.hw * cap * g * lipF * widthF];
  };
  const count = ctx.seg(64, 30);
  const sides = ctx.seg(22, 12);
  const sleeve = sleeveMesh(spine, shape, count, sides);
  const inserts: Mesh[] = [];
  if (spec.style === 'comfort') {
    const s0 = S * 0.2;
    const s1 = S * 0.8;
    const ribs = ctx.detail;
    const insertShape = (s: number): readonly [number, number] => {
      const [hz, hw] = shape(s);
      const edge = capFactor(s - s0, s1 - s0, 3.2, 3.2);
      const rib = ribs ? 1 + 0.03 * Math.cos((s * Math.PI * 2) / 2.8) : 1;
      return [hz * (0.94 + 0.09 * edge) * rib + 0.1, hw * (0.94 + 0.09 * edge) * rib + 0.1];
    };
    inserts.push(sleeveMesh(spine, insertShape, ctx.seg(120, 22), ctx.seg(22, 12), s0, s1));
  }
  return { spine, sleeve, inserts, bare: null };
}
