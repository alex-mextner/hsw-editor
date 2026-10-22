/**
 * Profile helpers shared by generators: smooth width profiles along the tool axis and polar rings.
 */
import { type V2, clamp, lerp, smoothCurve } from '../math.ts';
import type { Station } from './primitives.ts';

/** A control profile: [t in 0..1 along the part, factor]. */
export type Profile = readonly V2[];

/** Smooth a control profile with Catmull-Rom; the result is monotonic in t (control t must increase). */
export function smoothProfile(control: Profile, perSegment = 6): V2[] {
  return smoothCurve(control, perSegment, false);
}

/** Linear interpolation of a [t, v] control profile. */
export function sampleProfile(control: Profile, t: number): number {
  const c = clamp(t, control[0]?.[0] ?? 0, control[control.length - 1]?.[0] ?? 1);
  for (let i = 0; i < control.length - 1; i++) {
    const a = control[i] as V2;
    const b = control[i + 1] as V2;
    if (c >= a[0] && c <= b[0])
      return lerp(a[1], b[1], b[0] === a[0] ? 0 : (c - a[0]) / (b[0] - a[0]));
  }
  return (control[control.length - 1] as V2)[1];
}

/**
 * Stations along Y for a smooth profile. `ringAt(factor, t)` returns the ring at fractional position `t`
 * (0..1 between y0 and y1) for the profile factor there (e.g. a radius).
 */
export function profileStations(
  control: Profile,
  y0: number,
  y1: number,
  ringAt: (factor: number, t: number) => readonly V2[],
  perSegment = 6,
): Station[] {
  return smoothProfile(control, perSegment).map(([t, f]) => ({
    y: lerp(y0, y1, t),
    ring: ringAt(Math.max(0, f), t),
  }));
}

/** Closed ring from a polar radius function r(theta), `count` points evenly in angle (star-shaped only). */
export function polarRing(radius: (theta: number) => number, count: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / count) * Math.PI * 2;
    const r = radius(t);
    out.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return out;
}

/** Polar radius of a regular n-gon with inradius `inr` (a vertex sits on +x when phase = 0; the flat midpoint is at phase + half a wedge). */
export function polygonPolar(sides: number, inr: number, phase = 0): (theta: number) => number {
  const wedge = (Math.PI * 2) / sides;
  return (theta) => {
    const a = (((theta - phase) % wedge) + wedge) % wedge;
    return inr / Math.cos(a - wedge / 2);
  };
}

/** Polar radius of a "plus" made of two bars of half-length `reach` and half-thickness `thick`. */
export function crossPolar(
  reach: number,
  thick: number,
  extraRotation = 0,
): (theta: number) => number {
  return (theta) => {
    const a = theta - extraRotation;
    const c = Math.abs(Math.cos(a));
    const s = Math.abs(Math.sin(a));
    const bar1 = Math.min(c < 1e-9 ? Infinity : reach / c, s < 1e-9 ? Infinity : thick / s);
    const bar2 = Math.min(s < 1e-9 ? Infinity : reach / s, c < 1e-9 ? Infinity : thick / c);
    return Math.max(bar1, bar2);
  };
}
