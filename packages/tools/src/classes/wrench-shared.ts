/**
 * Shared geometry helpers of the wrench family: finishes, flat-plate head outlines (circle + fillet +
 * neck, optionally carved by an angled open-end jaw slot), rounded-bar lofts, grip sleeves and embossed
 * size stamps. Everything is built from closed shells (extrude / loft / box) that may overlap.
 */
import { DEG, type V2, lerp } from '../math.ts';
import { type Mesh, mergeMeshes } from '../mesh.ts';
import { type Material, METALS, rubber } from '../materials.ts';
import { type Station, at, box, extrude, loft, place, rotY } from '../build/primitives.ts';
import { offsetRing, roundedRectRing, scaleRing } from '../build/rings.ts';
import { GLYPHS, GLYPH_H, GLYPH_W } from '../render/font.ts';

/** Square drive sizes (inch) and their square side in mm (ASME B107.4). */
export const DRIVES = ['1/4', '3/8', '1/2'] as const;
export type Drive = (typeof DRIVES)[number];
export const DRIVE_MM: Record<Drive, number> = { '1/4': 6.35, '3/8': 9.525, '1/2': 12.7 };

export const FINISHES = ['chrome', 'satin', 'black-oxide'] as const;
export type Finish = (typeof FINISHES)[number];

export function finishMaterial(finish: Finish): Material {
  if (finish === 'chrome') return METALS.chrome;
  if (finish === 'satin') return METALS.chromeVanadium;
  return METALS.blackOxide;
}

/** Points on an arc, both end angles included. Angles in degrees, counter-clockwise from +x. */
export function arcPoints(
  cx: number,
  cy: number,
  r: number,
  fromDeg: number,
  toDeg: number,
  steps: number,
): V2[] {
  const out: V2[] = [];
  const n = Math.max(1, steps);
  for (let i = 0; i <= n; i++) {
    const a = (fromDeg + ((toDeg - fromDeg) * i) / n) * DEG;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Cubic Bezier from p0 to p3 including both ends. */
export function bezierPoints(p0: V2, p1: V2, p2: V2, p3: V2, steps: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    out.push([
      a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
      a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]);
  }
  return out;
}

export interface HandleOutlineSpec {
  y0: number;
  y1: number;
  /** Full widths at the butt and at y1. */
  wButt: number;
  wTop: number;
  buttRound: number;
  /** Hang hole through the butt. */
  hole: { y: number; r: number };
  steps: number;
}

/** Flat handle blank: tapered bar with rounded butt corners and a round hang hole. */
export function handleOutline(spec: HandleOutlineSpec): { outer: V2[]; hole: V2[] } {
  const { y0, y1, wButt, wTop, buttRound: rb, steps } = spec;
  const hw = wButt / 2;
  const outer: V2[] = [
    [wTop / 2, y1],
    ...arcPoints(hw - rb, y0 + rb, rb, 0, -90, steps),
    ...arcPoints(-(hw - rb), y0 + rb, rb, -90, -180, steps),
    [-wTop / 2, y1],
  ];
  const hole = arcPoints(0, spec.hole.y, spec.hole.r, 0, 360, steps * 4).slice(0, -1);
  return { outer, hole };
}

/** Sorted, de-duplicated sample positions: `count` evenly spaced plus the `extra` ones. */
export function stationYs(
  y0: number,
  y1: number,
  count: number,
  extra: readonly number[],
): number[] {
  const all: number[] = [];
  for (let i = 0; i <= count; i++) all.push(lerp(y0, y1, i / count));
  for (const e of extra) if (e > y0 && e < y1) all.push(e);
  all.sort((a, b) => a - b);
  const out: number[] = [];
  for (const y of all) {
    const last = out[out.length - 1];
    if (last === undefined || y - last > 0.05) out.push(y);
  }
  return out;
}

/** Jaw slot of an open-end head: flats `halfGap` from the jaw axis, axis tilted `tiltDeg` off the head axis. */
export interface JawNotch {
  halfGap: number;
  tiltDeg: number;
}

export interface HeadOutlineSpec {
  /** Radius of the round head. */
  radius: number;
  /** Half width of the neck (the handle) the head blends into. */
  neckHalf: number;
  /** Fillet radius between head circle and neck. */
  fillet: number;
  /** Straight neck length beyond the fillet start (overlap with the bar). */
  neckExtra: number;
  /** Arc samples per 90 degrees. */
  steps: number;
  notch?: JawNotch;
}

export interface HeadOutline {
  /** Counter-clockwise from the right neck end around the head to the left neck end. Local frame: x lateral, s outward. */
  ring: V2[];
  /** s of the straight neck start (negative). */
  neckStart: number;
  /** s where the fillet meets the straight neck (negative). */
  filletStart: number;
}

/** Bottom of the jaw slot in units of halfGap, hugging a hex nut corner (from +x flat to -x flat). */
const SLOT_BOTTOM: readonly V2[] = [
  [1, -0.64],
  [0.74, -0.98],
  [0.3, -1.2],
  [-0.3, -1.2],
  [-0.74, -0.98],
  [-1, -0.64],
];

/** Slot flats run straight to `MOUTH_START` x halfGap above the jaw centre, then open at `MOUTH_FLARE`. */
const MOUTH_START = 1.1;
const MOUTH_FLARE = Math.tan(13 * DEG);

function carveNotch(points: readonly V2[], notch: JawNotch): V2[] {
  const h = notch.halfGap;
  const th = notch.tiltDeg * DEG;
  const nx = Math.cos(th);
  const ny = Math.sin(th);
  const ux = -Math.sin(th);
  const uy = Math.cos(th);
  const u0 = MOUTH_START * h;
  const lx = (p: V2): number => p[0] * nx + p[1] * ny;
  const lu = (p: V2): number => p[0] * ux + p[1] * uy;
  const reach = (p: V2): number => h + Math.max(0, lu(p) - u0) * MOUTH_FLARE;
  const inside = (p: V2): boolean => Math.abs(lx(p)) < reach(p) && lu(p) > 0;
  const toLocal = (x: number, u: number): V2 => [x * nx + u * ux, x * ny + u * uy];
  /** Where the outline edge p -> q meets the flared slot wall on `side` (+1 / -1). */
  const crossing = (p: V2, q: V2, side: number): V2 => {
    const f = (r: V2): number => side * lx(r) - reach(r);
    const t = f(p) / (f(p) - f(q));
    return [lerp(p[0], q[0], t), lerp(p[1], q[1], t)];
  };
  const out: V2[] = [points[0] as V2];
  for (let i = 0; i < points.length - 1; i++) {
    const p = points[i] as V2;
    const q = points[i + 1] as V2;
    const pin = inside(p);
    const qin = inside(q);
    if (!pin && qin) {
      const side = Math.sign(lx(p)) || 1;
      out.push(crossing(p, q, side), toLocal(side * h, u0));
      const bottom = side > 0 ? SLOT_BOTTOM : [...SLOT_BOTTOM].reverse();
      for (const [bx, bu] of bottom) out.push(toLocal(bx * h, bu * h));
    } else if (pin && !qin) {
      const side = Math.sign(lx(q)) || -1;
      out.push(toLocal(side * h, u0), crossing(p, q, side), q);
    } else if (!pin && !qin) out.push(q);
  }
  return out;
}

/** Outline of one wrench head: circle blended into a straight neck by fillets, optionally with a jaw slot. */
export function headOutline(spec: HeadOutlineSpec): HeadOutline {
  const { radius: R, neckHalf: nw, fillet: rf, steps } = spec;
  const fcx = nw + rf;
  const fcs = -Math.sqrt((R + rf) * (R + rf) - fcx * fcx);
  const k = R / (R + rf);
  const tx = fcx * k;
  const ts = fcs * k;
  const phi = Math.atan2(ts, tx) / DEG;
  const fromFillet = 180;
  const toFillet = phi + 180;
  const fillet = arcPoints(fcx, fcs, rf, fromFillet, toFillet, Math.max(2, Math.round(steps / 2)));
  const circle = arcPoints(0, 0, R, phi, 180 - phi, Math.ceil(((180 - 2 * phi) / 90) * steps));
  const left = fillet.map((p): V2 => [-p[0], p[1]]).reverse();
  const s0 = fcs - spec.neckExtra;
  let ring: V2[] = [[nw, s0], ...fillet, ...circle.slice(1, -1), ...left, [-nw, s0]];
  if (spec.notch) ring = carveNotch(ring, spec.notch);
  return { ring, neckStart: s0, filletStart: fcs };
}

/** Head outline placed in the wrench plane: `dir` +1 opens towards +y, -1 towards -y (rotated half a turn). */
export function placeOutline(ring: readonly V2[], yc: number, dir: 1 | -1, xc = 0): V2[] {
  return ring.map(([x, s]): V2 => (dir > 0 ? [xc + x, yc + s] : [xc - x, yc - s]));
}

/** One horizontal run of lit font pixels: centre (u along the reading direction, v downwards) and length, in pixels. */
interface GlyphRun {
  u: number;
  v: number;
  len: number;
}

/** Pixel-font runs of `text`, centred on the origin. */
function glyphRuns(text: string): GlyphRun[] {
  const lit: [number, number][] = [];
  let x0 = 0;
  for (const ch of text) {
    const g = (ch.charCodeAt(0) - 32) * GLYPH_H;
    for (let r = 0; r < GLYPH_H; r++) {
      const bits = GLYPHS[g + r] ?? 0;
      for (let c = 0; c < GLYPH_W; c++) {
        if (bits & (1 << (GLYPH_W - 1 - c))) lit.push([x0 + c, r]);
      }
    }
    x0 += GLYPH_W;
  }
  if (lit.length === 0) return [];
  const c0 = (Math.min(...lit.map((l) => l[0])) + Math.max(...lit.map((l) => l[0])) + 1) / 2;
  const r0 = (Math.min(...lit.map((l) => l[1])) + Math.max(...lit.map((l) => l[1])) + 1) / 2;
  const byRow = new Map<number, number[]>();
  for (const [c, r] of lit) byRow.set(r, [...(byRow.get(r) ?? []), c]);
  const runs: GlyphRun[] = [];
  for (const [r, cs] of byRow) {
    cs.sort((a, b) => a - b);
    let start = cs[0] as number;
    let prev = start;
    for (const c of [...cs.slice(1), Infinity]) {
      if (c === prev + 1) {
        prev = c;
        continue;
      }
      const len = prev - start + 1;
      runs.push({ u: start + len / 2 - c0, v: r + 0.5 - r0, len });
      start = c;
      prev = c;
    }
  }
  return runs;
}

/** Stamped-metal marking on a flat face: pixel-font boxes. Text reads along +y (rotated a quarter turn) when `alongY`. */
export function stampText(
  text: string,
  cx: number,
  cy: number,
  pixel: number,
  zBase: number,
  zTop: number,
  alongY: boolean,
): Mesh | null {
  const depth = zTop - zBase;
  const zc = (zBase + zTop) / 2;
  const meshes = glyphRuns(text).map((r) =>
    alongY
      ? place(box(pixel, r.len * pixel, depth), at(cx + r.v * pixel, cy + r.u * pixel, zc))
      : place(box(r.len * pixel, pixel, depth), at(cx + r.u * pixel, cy - r.v * pixel, zc)),
  );
  return meshes.length > 0 ? mergeMeshes(meshes) : null;
}

/** Marking wrapped round a cylinder (axis Y) of `radius`, centred on +z at height `cy`; reads round the circumference. */
export function wrapText(
  text: string,
  radius: number,
  cy: number,
  pixel: number,
  embed: number,
  raise: number,
): Mesh | null {
  const depth = embed + raise;
  const meshes = glyphRuns(text).map((r) => {
    const phi = (r.u * pixel) / radius / DEG;
    return place(
      box(r.len * pixel, pixel, depth),
      at(0, cy - r.v * pixel, radius - embed + depth / 2),
      rotY(phi),
    );
  });
  return meshes.length > 0 ? mergeMeshes(meshes) : null;
}

export interface BarSection {
  y: number;
  width: number;
  thick: number;
  /** z of the section centre. */
  z: number;
}

/** Flat bar with fully rounded long edges through the given sections (forged wrench shank). */
export function barLoft(sections: readonly BarSection[], perCorner: number): Mesh {
  const stations: Station[] = sections.map((s) => ({
    y: s.y,
    ring: offsetRing(
      roundedRectRing(s.width, s.thick, Math.min(s.thick * 0.45, s.width * 0.3), perCorner),
      0,
      s.z,
    ),
  }));
  return loft(stations);
}

export type GripKind = 'bare' | 'dipped' | 'rubber';

export interface SleeveSpec {
  y0: number;
  y1: number;
  /** Core width / thickness at y. */
  width: (y: number) => number;
  thick: (y: number) => number;
  /** Coating thickness on each side. */
  over: number;
  /** Stations; more at LOD0. */
  count: number;
  /** Circumferential grooves at these y (finger grooves, dip-line). */
  grooves: readonly number[];
  grooveDepth: number;
  /** Extra bulge of the middle, as a fraction of the section (ergonomic soft grip). */
  bulge: number;
  perCorner: number;
}

/** Coating / over-mould around a flat handle: rounded-rect sections with soft rounded ends and optional grooves. */
export function sleeve(spec: SleeveSpec): Mesh {
  const lip = Math.min(1.4, (spec.y1 - spec.y0) * 0.1);
  const grooveHalf = 0.7;
  const ys = new Set<number>([spec.y0, spec.y0 + lip * 0.45, spec.y1 - lip * 0.45, spec.y1]);
  for (const y of stationYs(spec.y0 + lip * 0.5, spec.y1 - lip * 0.5, spec.count, [])) ys.add(y);
  const dip = new Map<number, number>();
  for (const g of spec.grooves) {
    dip.set(g, spec.grooveDepth);
    ys.add(g - grooveHalf)
      .add(g)
      .add(g + grooveHalf);
  }
  const sorted = [...ys].sort((a, b) => a - b);
  const stations: Station[] = [];
  for (const y of sorted) {
    if (stations.length > 0 && y - (stations[stations.length - 1] as Station).y < 0.05) continue;
    const u = (y - spec.y0) / (spec.y1 - spec.y0);
    const bulge = 1 + spec.bulge * Math.sin(Math.PI * u);
    const w = (spec.width(y) + 2 * spec.over) * bulge;
    const t = (spec.thick(y) + 2 * spec.over) * bulge;
    const end = Math.min(y - spec.y0, spec.y1 - y);
    const shrink = end < lip * 0.1 ? 0.9 : end < lip * 0.5 ? 0.985 : 1;
    const groove = 1 - ((dip.get(y) ?? 0) / t) * 0.5;
    stations.push({
      y,
      ring: scaleRing(
        roundedRectRing(w, t, Math.min(t * 0.42, w * 0.3), spec.perCorner),
        shrink * groove,
      ),
    });
  }
  return loft(stations);
}

export function gripMaterial(kind: GripKind, color: string): Material {
  return rubber(
    color,
    kind === 'rubber' ? 'ribbed' : 'smooth',
    kind === 'rubber' ? 'rubber grip' : 'dip coating',
  );
}

/** Flat plate (extrude) with a polygon outline, thickness centred on `zc`. */
export function plate(
  outline: readonly V2[],
  zc: number,
  thick: number,
  bevel: number,
  holes: readonly (readonly V2[])[] = [],
): Mesh {
  return extrude(outline, zc - thick / 2, zc + thick / 2, { bevel, holes });
}
