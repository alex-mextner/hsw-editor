/**
 * Screwdriver bit with a 1/4 in hex shank (6.35 mm across flats): 25 mm short, 50 mm long, up to 100 mm.
 * One lofted body: chamfered shank end, retention groove, optional torsion waist, tip morphing from the hex
 * into slotted / Phillips / Pozidriv / Torx / hex / square. Optional magnetic or colour-coding ring.
 * Sizes after DIN 3126 / ISO 1173 (shank), ISO 8764 (PH/PZ), ISO 10664 (Torx).
 */
import { type V2, lerp, smoothstep } from '../../math.ts';
import { METALS, type Material, plastic } from '../../materials.ts';
import type { BuiltTool } from '../../model.ts';
import { L, choice, color, num } from '../../params.ts';
import { type BuildCtx, defineToolClass } from '../../registry.ts';
import { type Station, lathe, loft } from '../../build/primitives.ts';
import { polarRing, polygonPolar } from '../../build/profile.ts';
import { blendRings, circleRing, resampleRing } from '../../build/rings.ts';
import type { Mesh } from '../../mesh.ts';
import { HEX_QUARTER, TITANIUM } from './shared.ts';

export const BIT_TIPS = ['slotted', 'phillips', 'pozidriv', 'torx', 'hex', 'square'] as const;
export type BitTip = (typeof BIT_TIPS)[number];
export const BIT_STYLES = ['standard', 'torsion'] as const;
export type BitStyle = (typeof BIT_STYLES)[number];

const AF_R = HEX_QUARTER / 2;
const HEX_R = AF_R / Math.cos(Math.PI / 6);

export interface BitSpec {
  tip: BitTip;
  tipSize: number;
  length: number;
  style: BitStyle;
  /** Ring resolution (multiple of 12) and number of tip stations. */
  N: number;
  tipSteps: number;
}

const hexPolar = polygonPolar(6, AF_R);

/** Radial function |x/a|^n + |z/b|^n = 1. */
function superPolar(a: number, b: number, n: number): (t: number) => number {
  return (t) => {
    const c = Math.abs(Math.cos(t)) / a;
    const s = Math.abs(Math.sin(t)) / b;
    return (c ** n + s ** n) ** (-1 / n);
  };
}

/** Length of the working taper of a bit of this overall length. */
export const bitTipLength = (length: number): number => Math.min(9, length * 0.34);

/** Radius function of the tip at fraction u (0 at the hex, 1 at the end face). */
function tipShape(
  tip: Exclude<BitTip, 'phillips' | 'pozidriv'>,
  size: number,
  u: number,
): (t: number) => number {
  const tipR = size / 2;
  if (tip === 'slotted') {
    const thick = Math.max(0.5, Math.min(1.8, 0.14 * size + 0.15));
    const e = smoothstep(0, 0.7, u);
    const end = u > 0.95 ? 0.85 : 1;
    const sup = superPolar(
      lerp(HEX_R, tipR, e),
      lerp(AF_R, (thick / 2) * end, e),
      lerp(2, 9, smoothstep(0, 0.6, u)),
    );
    const b = smoothstep(0, 0.3, u);
    return (t) => lerp(hexPolar(t), sup(t), b);
  }
  const taper = 1 - 0.1 * smoothstep(0.6, 1, u);
  const b = smoothstep(0, 0.5, u);
  if (tip === 'torx') {
    const R = lerp(HEX_R, tipR, smoothstep(0, 0.6, u)) * taper;
    return (t) => lerp(hexPolar(t), R * (0.855 + 0.145 * Math.cos(6 * t)), b);
  }
  if (tip === 'hex') {
    const inr = lerp(AF_R, Math.min(tipR, AF_R * 0.999), smoothstep(0, 0.6, u)) * taper;
    const p = polygonPolar(6, inr);
    return (t) => lerp(hexPolar(t), p(t), b);
  }
  const inr = lerp(AF_R, tipR, smoothstep(0, 0.6, u)) * taper;
  const sq = polygonPolar(4, inr);
  return (t) => lerp(hexPolar(t), Math.min(sq(t), HEX_R), b);
}

/** Closed polygon sampled with `n` points, evenly per edge when the vertex count divides `n`. */
function polyRing(vertices: readonly V2[], n: number): V2[] {
  const v = vertices.length;
  if (n % v !== 0) return resampleRing(vertices, n);
  const per = n / v;
  const out: V2[] = [];
  for (let i = 0; i < v; i++) {
    const p = vertices[i] as V2;
    const q = vertices[(i + 1) % v] as V2;
    for (let k = 0; k < per; k++) out.push([lerp(p[0], q[0], k / per), lerp(p[1], q[1], k / per)]);
  }
  return out;
}

/** Phillips / Pozidriv section: four wings of half thickness `thick`, Pozidriv adds 45 degree ribs. */
function crossVertices(reach: number, thick: number, pozi: boolean): V2[] {
  const rho = thick * 0.5;
  // the rib must start beyond the wing/rib junction (1.914 * thick on the diagonal) or the outline folds
  const rib = Math.max(reach * 0.74, thick * 2.4);
  const quadrant: V2[] = [
    [reach, -thick],
    [reach, thick],
  ];
  if (pozi) {
    const s2 = Math.SQRT2;
    quadrant.push(
      [thick + s2 * rho, thick],
      [(rib + rho) / s2, (rib - rho) / s2],
      [(rib - rho) / s2, (rib + rho) / s2],
      [thick, thick + s2 * rho],
    );
  } else quadrant.push([thick, thick]);
  const out: V2[] = [];
  for (let k = 0; k < 4; k++) {
    const c = Math.round(Math.cos((k * Math.PI) / 2));
    const sn = Math.round(Math.sin((k * Math.PI) / 2));
    for (const [x, y] of quadrant) out.push([x * c - y * sn, x * sn + y * c]);
  }
  return out;
}

function tipRing(tip: BitTip, size: number, u: number, N: number): V2[] {
  if (tip !== 'phillips' && tip !== 'pozidriv') return polarRing(tipShape(tip, size, u), N);
  const tipR = size / 2;
  const reach = lerp(HEX_R, tipR * 0.5, u);
  const thick = lerp(HEX_R * 0.9, tipR * 0.17 + 0.12, smoothstep(0.1, 0.8, u));
  const cross = polyRing(crossVertices(reach, Math.min(thick, reach * 0.6), tip === 'pozidriv'), N);
  const blended = blendRings(polarRing(hexPolar, N), cross, smoothstep(0, 0.45, u));
  // the hex is turned down to a cone first, the wing grooves are cut into it
  return blended.map(([x, z]) => {
    const r = Math.hypot(x, z);
    const k = r > reach ? reach / r : 1;
    return [x * k, z * k];
  });
}

/** Stations of a complete bit along +Y: shank end at y = 0, tip end at y = length. */
export function bitStations(spec: BitSpec): Station[] {
  const { N, length } = spec;
  const hex = polarRing(hexPolar, N);
  const scaled = (f: number): V2[] => hex.map(([x, z]) => [x * f, z * f]);
  const tipLen = bitTipLength(length);
  const yTip0 = length - tipLen;
  const out: Station[] = [
    { y: 0, ring: scaled(0.82) },
    { y: 0.7, ring: scaled(1) },
    { y: 2.9, ring: scaled(1) },
    { y: 3.45, ring: scaled(0.86) },
    { y: 3.95, ring: scaled(0.86) },
    { y: 4.5, ring: scaled(1) },
  ];
  if (spec.style === 'torsion') {
    const waist = circleRing(AF_R * 0.84, N);
    const w0 = yTip0 - 11;
    out.push(
      { y: w0, ring: hex },
      { y: w0 + 3, ring: waist },
      { y: yTip0 - 3, ring: waist },
      { y: yTip0, ring: hex },
    );
  } else out.push({ y: yTip0, ring: hex });
  const K = spec.tipSteps;
  for (let k = 1; k <= K; k++) {
    const u = k / K;
    out.push({ y: yTip0 + tipLen * u, ring: tipRing(spec.tip, spec.tipSize, u, N) });
  }
  // ground end face: a short chamfer ahead of the last station, sampled on the same taper
  const last = out.pop() as Station;
  const c = Math.min(0.4, (0.5 * tipLen) / K);
  out.push(
    { y: last.y - c, ring: tipRing(spec.tip, spec.tipSize, 1 - c / tipLen, N) },
    { y: last.y, ring: last.ring.map(([x, z]) => [x * 0.9, z * 0.9]) },
  );
  return out;
}

export const bitMesh = (spec: BitSpec): Mesh => loft(bitStations(spec));

const COATINGS = ['chrome-vanadium', 'black', 'titanium'] as const;
const RINGS = ['none', 'magnetic', 'colour'] as const;

function coatingMaterial(c: (typeof COATINGS)[number]): Material {
  return c === 'chrome-vanadium'
    ? METALS.chromeVanadium
    : c === 'black'
      ? METALS.blackOxide
      : TITANIUM;
}

const schema = {
  tip: choice(L('Tip type', 'Тип шлица'), BIT_TIPS, 'phillips'),
  tipSize: num(L('Tip size (width / across flats)', 'Размер жала'), 5.4, 1.5, 7, { step: 0.1 }),
  length: num(L('Bit length', 'Длина биты'), 25, 25, 100, { step: 5 }),
  style: choice(L('Shank style', 'Тип хвостовика'), BIT_STYLES, 'standard'),
  coating: choice(L('Coating', 'Покрытие'), COATINGS, 'chrome-vanadium'),
  ring: choice(L('Ring', 'Кольцо'), RINGS, 'none'),
  ringColor: color(L('Ring colour', 'Цвет кольца'), '#c8262b'),
};

export const driverBit = defineToolClass({
  id: 'driver-bit',
  family: 'drivers',
  name: L('Screwdriver bit', 'Бита для отвёртки'),
  bankClass: 'bit-set',
  keywords: {
    en: [
      'screwdriver bit',
      'driver bit',
      'phillips bit',
      'torx bit',
      'hex shank bit',
      'insert bit',
    ],
    ru: ['бита', 'насадка для шуруповерта', 'бита крестовая', 'бита torx'],
  },
  schema,
  presets: [
    { id: 'ph2-25', label: L('PH2, 25 mm', 'PH2, 25 мм'), values: {} },
    {
      id: 'pz2-50-ring',
      label: L('PZ2, 50 mm, colour ring', 'PZ2, 50 мм, кольцо'),
      values: { tip: 'pozidriv', tipSize: 5.6, length: 50, ring: 'colour', ringColor: '#d9b21c' },
    },
    {
      id: 'sl65-25',
      label: L('Slotted 6.5, 25 mm', 'Шлиц 6,5, 25 мм'),
      values: { tip: 'slotted', tipSize: 6.5 },
    },
    {
      id: 't25-50-torsion',
      label: L('T25, 50 mm, torsion, black', 'T25, 50 мм, торсионная'),
      values: { tip: 'torx', tipSize: 4.4, length: 50, style: 'torsion', coating: 'black' },
    },
    {
      id: 'hex5-magnetic',
      label: L('Hex 5, 50 mm, magnetic ring', 'Шестигранник 5, магнит'),
      values: { tip: 'hex', tipSize: 5, length: 50, ring: 'magnetic', coating: 'titanium' },
    },
    {
      id: 'sq2-25',
      label: L('Square SQ2, 25 mm', 'Квадрат SQ2, 25 мм'),
      values: { tip: 'square', tipSize: 4.2, coating: 'black' },
    },
  ],
  build(p, ctx: BuildCtx): BuiltTool {
    const N = ctx.seg(96, 36);
    const mesh = bitMesh({
      tip: p.tip,
      tipSize: p.tipSize,
      length: p.length,
      style: p.style,
      N,
      tipSteps: ctx.seg(14, 6),
    });
    const mat = coatingMaterial(p.coating);
    const parts = [{ name: 'bit', role: 'tip', material: mat, mesh, crease: 30 }];
    const tipLen = bitTipLength(p.length);
    if (p.ring !== 'none') {
      const yr = p.length - tipLen - 7.5;
      const seg = ctx.seg(40, 20);
      const m: Material =
        p.ring === 'magnetic'
          ? { ...METALS.darkSteel, name: 'magnet ring', roughness: 0.5 }
          : plastic(p.ringColor, 0.4, 'colour ring');
      parts.push({
        name: 'ring',
        role: 'collar',
        material: m,
        mesh: lathe(
          [
            [4.1, yr],
            [4.9, yr + 0.45],
            [5.1, yr + 1.2],
            [5.1, yr + 5.2],
            [4.9, yr + 5.95],
            [4.1, yr + 6.4],
          ],
          seg,
        ),
        crease: 45,
      });
    }
    return {
      parts,
      hang: { point: [0, p.length / 2, 0], kind: 'body' },
      zones: [
        { name: 'shank', y0: 0, y1: p.length - tipLen },
        { name: 'tip', y0: p.length - tipLen, y1: p.length },
      ],
      dims: {
        length: p.length,
        shaftDiameter: HEX_QUARTER,
        shankAcrossFlats: HEX_QUARTER,
        tipWidth: p.tipSize,
        ...(p.ring === 'none' ? {} : { collarDiameter: 10.2 }),
      },
    };
  },
});
