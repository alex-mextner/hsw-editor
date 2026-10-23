/**
 * Twist drill bit, 1..13 mm. The fluted body is ONE loft whose ring (two flutes, lands, web) twists along
 * Y at a 30 degree helix, clipped by a 118 degree cone with a relief tilt, so flutes, lands and the chisel
 * point read like the real thing. Lengths follow DIN 338 (jobber), DIN 1897 (stub) and DIN 340 (long).
 * Shank: straight, reduced, tri-flat or 1/4 in hex with retention groove. Butt at y = 0, point at +Y.
 */
import { type V2, clamp, lerp, smoothstep } from '../../math.ts';
import { METALS, type Material } from '../../materials.ts';
import type { BuiltTool } from '../../model.ts';
import { L, choice, num } from '../../params.ts';
import { defineToolClass } from '../../registry.ts';
import { type Station, lathe, loft } from '../../build/primitives.ts';
import { polarRing, polygonPolar } from '../../build/profile.ts';
import { circleRing } from '../../build/rings.ts';
import type { Mesh } from '../../mesh.ts';
import { BRONZE_OXIDE, HEX_QUARTER, TITANIUM } from './shared.ts';

export const DRILL_SERIES = ['jobber', 'stub', 'long'] as const;
export type DrillSeries = (typeof DRILL_SERIES)[number];
export const DRILL_SHANKS = ['straight', 'reduced', 'tri-flat', 'hex'] as const;
export type DrillShank = (typeof DRILL_SHANKS)[number];
const FINISHES = ['bright', 'black-oxide', 'titanium', 'bronze'] as const;

const DIAMETERS = [1, 2, 3, 4, 5, 6, 8, 10, 13] as const;
const TABLE: Record<DrillSeries, { total: readonly number[]; flute: readonly number[] }> = {
  jobber: {
    total: [34, 49, 61, 75, 86, 93, 117, 133, 151],
    flute: [12, 24, 33, 43, 52, 57, 75, 87, 101],
  },
  stub: {
    total: [26, 38, 46, 55, 62, 66, 79, 89, 101],
    flute: [6, 12, 19, 24, 30, 34, 41, 47, 54],
  },
  long: {
    total: [56, 85, 100, 119, 132, 139, 165, 184, 205],
    flute: [33, 56, 70, 87, 99, 106, 128, 142, 161],
  },
};

function interp(values: readonly number[], d: number): number {
  const c = clamp(d, 1, 13);
  for (let i = 0; i < DIAMETERS.length - 1; i++) {
    const a = DIAMETERS[i] as number;
    const b = DIAMETERS[i + 1] as number;
    if (c <= b) return lerp(values[i] as number, values[i + 1] as number, (c - a) / (b - a));
  }
  return values[values.length - 1] as number;
}

/** Overall length and flute length of a standard drill. */
export function drillLengths(d: number, series: DrillSeries): { total: number; flute: number } {
  const t = TABLE[series];
  const total = interp(t.total, d);
  return { total, flute: Math.min(interp(t.flute, d), total - 14) };
}

export interface DrillSpec {
  diameter: number;
  total: number;
  flute: number;
  pointAngle: number;
  shank: DrillShank;
  /** Ring resolution (multiple of 6) and stations per helix revolution. */
  N: number;
  perRev: number;
  coneSteps: number;
}

const WEB = 0.19;
const HELIX = Math.PI / 6;

/** Normalised radius of the two-flute section at angle `theta` from a flute centre. */
function fluteRadius(theta: number): number {
  const a = ((((theta + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2;
  const x = Math.abs(a);
  const w = a < 0 ? 0.62 : 0.74;
  const edge = 0.12;
  if (x >= w + edge) return 1;
  if (x >= w) return lerp(0.9, 1, smoothstep(0, 1, (x - w) / edge));
  return WEB + (0.9 - WEB) * (x / w) ** 1.8;
}

/** `count` angles whose points on the unit-radius flute section are evenly spaced along the outline. */
const angleCache = new Map<number, number[]>();

function arcLengthAngles(count: number): number[] {
  const cached = angleCache.get(count);
  if (cached) return cached;
  const fine = 1440;
  const cum: number[] = [0];
  let prev: V2 = [fluteRadius(0), 0];
  for (let i = 1; i <= fine; i++) {
    const t = (i / fine) * Math.PI * 2;
    const r = fluteRadius(t);
    const cur: V2 = [r * Math.cos(t), r * Math.sin(t)];
    cum.push((cum[i - 1] ?? 0) + Math.hypot(cur[0] - prev[0], cur[1] - prev[1]));
    prev = cur;
  }
  const total = cum[fine] as number;
  const out: number[] = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = (k / count) * total;
    while (j < fine && (cum[j + 1] ?? 0) < target) j++;
    const span = (cum[j + 1] ?? 0) - (cum[j] ?? 0);
    const u = span < 1e-12 ? 0 : (target - (cum[j] ?? 0)) / span;
    out.push(((j + u) / fine) * Math.PI * 2);
  }
  angleCache.set(count, out);
  return out;
}

export interface DrillMeshes {
  body: Mesh;
  shank: Mesh;
  shankLength: number;
}

/** Radius of a reduced (stepped-down) shank: 72 % of the drill, never wider than the drill itself. */
export const reducedShankRadius = (R: number): number =>
  Math.min(R * 0.95, Math.max(1.2, R * 0.72));

export function drillMeshes(spec: DrillSpec): DrillMeshes {
  const R = spec.diameter / 2;
  const total = spec.total;
  const yF0 = total - spec.flute;
  const tanHalf = Math.tan((spec.pointAngle / 2) * (Math.PI / 180));
  const coneLen = R / tanHalf;
  const drop = 0.16 * spec.diameter;
  // rounded minimum between flute section and point cone: smooths the lip edge
  const blend = 0.05 * spec.diameter;
  const lead = (Math.PI * spec.diameter) / Math.tan(HELIX);
  const twist = (y: number): number => -((2 * Math.PI) / lead) * (y - total);
  const runout = Math.min(0.9 * spec.diameter + 1, spec.flute * 0.25);
  const yCone0 = total - drop - coneLen - 0.02;

  // ring vertices are spread evenly in arc length of the full-depth section and ride the helix, so
  // lands and flute edges stay on single mesh lines along the whole body
  const angles = arcLengthAngles(spec.N);
  const ringAt = (y: number): V2[] => {
    const depth = smoothstep(0, 1, (y - yF0) / runout);
    const phi = twist(y);
    return angles.map((tp) => {
      const t = tp + phi;
      const frac = (((t % Math.PI) + Math.PI) % Math.PI) / Math.PI;
      const cone = Math.max(0, total - drop * frac - y) * tanHalf;
      const a = R * lerp(1, fluteRadius(tp), depth);
      const r = Math.max(0, 0.5 * (a + cone - Math.sqrt((a - cone) ** 2 + blend * blend)));
      return [r * Math.cos(t), r * Math.sin(t)];
    });
  };

  const stations: Station[] = [];
  const dy = lead / spec.perRev;
  const nBody = Math.max(2, Math.ceil((yCone0 - yF0) / dy));
  for (let k = 0; k <= nBody; k++) {
    const y = lerp(yF0, yCone0, k / nBody);
    stations.push({ y, ring: ringAt(y) });
  }
  for (let k = 1; k <= spec.coneSteps; k++) {
    const u = (k / spec.coneSteps) ** 0.75;
    stations.push({ y: lerp(yCone0, total, u), ring: ringAt(lerp(yCone0, total, u)) });
  }
  const body = loft(stations);

  // shank: it ends 0.6 mm inside the fluted body so the shells overlap
  const yS = yF0 + 0.6;
  const segs = Math.max(12, Math.round(spec.N * 0.55));
  const cham = Math.min(0.5, R * 0.3);
  let shank: Mesh;
  if (spec.shank === 'straight') {
    shank = lathe(
      [
        [R - cham, 0],
        [R, cham],
        [R, yS],
      ],
      segs,
    );
  } else if (spec.shank === 'reduced') {
    const rs = reducedShankRadius(R);
    shank = lathe(
      [
        [rs - cham, 0],
        [rs, cham],
        [rs, Math.max(cham + 0.5, yF0 - 3)],
        [R, yS],
      ],
      segs,
    );
  } else if (spec.shank === 'tri-flat') {
    const d = 0.88 * R;
    const ring = (f: number): V2[] =>
      polarRing((t) => {
        const wedge = (Math.PI * 2) / 3;
        const delta = ((t - Math.PI / 2 + wedge / 2 + 10 * wedge) % wedge) - wedge / 2;
        return f * Math.min(R, d / Math.cos(delta));
      }, spec.N);
    shank = loft([
      { y: 0, ring: ring(0.88) },
      { y: cham + 0.2, ring: ring(1) },
      { y: yS, ring: ring(1) },
    ]);
  } else {
    const hex = polarRing(polygonPolar(6, HEX_QUARTER / 2), spec.N);
    const sc = (f: number): V2[] => hex.map(([x, z]) => [x * f, z * f]);
    const hexLen = Math.max(8, yF0 - 3);
    shank = loft([
      { y: 0, ring: sc(0.82) },
      { y: 0.7, ring: sc(1) },
      { y: 2.9, ring: sc(1) },
      { y: 3.45, ring: sc(0.86) },
      { y: 3.95, ring: sc(0.86) },
      { y: 4.5, ring: sc(1) },
      { y: hexLen, ring: hex },
      { y: yS, ring: circleRing(R, spec.N) },
    ]);
  }
  return { body, shank, shankLength: yF0 };
}

export function drillFinishMaterials(f: (typeof FINISHES)[number]): {
  body: Material;
  shank: Material;
} {
  if (f === 'bright') return { body: METALS.polishedSteel, shank: METALS.polishedSteel };
  if (f === 'black-oxide') return { body: METALS.blackOxide, shank: METALS.blackOxide };
  if (f === 'titanium') return { body: TITANIUM, shank: METALS.steel };
  return { body: BRONZE_OXIDE, shank: METALS.steel };
}

const schema = {
  diameter: num(L('Diameter', 'Диаметр'), 6, 1, 13, { step: 0.5 }),
  series: choice(L('Length series', 'Серия длины'), DRILL_SERIES, 'jobber'),
  shank: choice(L('Shank', 'Хвостовик'), DRILL_SHANKS, 'straight'),
  pointAngle: num(L('Point angle', 'Угол при вершине'), 118, 90, 140, { step: 1, unit: 'deg' }),
  finish: choice(L('Finish', 'Покрытие'), FINISHES, 'black-oxide'),
};

export const drillBit = defineToolClass({
  id: 'drill-bit',
  family: 'drivers',
  name: L('Twist drill bit', 'Спиральное сверло'),
  bankClass: 'drill-bit',
  keywords: {
    en: ['drill bit', 'twist drill bit', 'hss drill bit', 'metal drill bit', 'drill'],
    ru: ['сверло', 'спиральное сверло', 'сверло по металлу'],
  },
  schema,
  presets: [
    { id: 'd6-black', label: L('6 mm HSS black oxide', '6 мм HSS, оксид'), values: {} },
    {
      id: 'd3-bright',
      label: L('3 mm HSS bright', '3 мм HSS, шлифованное'),
      values: { diameter: 3, finish: 'bright' },
    },
    {
      id: 'd8-titanium',
      label: L('8 mm TiN, tri-flat', '8 мм TiN, трёхгранный хвостовик'),
      values: { diameter: 8, finish: 'titanium', shank: 'tri-flat' },
    },
    {
      id: 'd13-reduced',
      label: L('13 mm, reduced shank', '13 мм, уменьшенный хвостовик'),
      values: { diameter: 13, shank: 'reduced', finish: 'bronze' },
    },
    {
      id: 'd5-hex-stub',
      label: L('5 mm stub, hex shank', '5 мм короткое, шестигранный хвостовик'),
      values: { diameter: 5, series: 'stub', shank: 'hex', finish: 'titanium', pointAngle: 135 },
    },
    {
      id: 'd10-long',
      label: L('10 mm long series', '10 мм, длинное'),
      values: { diameter: 10, series: 'long', finish: 'bright' },
    },
  ],
  build(p, ctx): BuiltTool {
    const { total, flute } = drillLengths(p.diameter, p.series);
    const m = drillMeshes({
      diameter: p.diameter,
      total,
      flute,
      pointAngle: p.pointAngle,
      shank: p.shank,
      N: ctx.seg(72, 36),
      perRev: ctx.seg(30, 12),
      coneSteps: ctx.seg(22, 8),
    });
    const mats = drillFinishMaterials(p.finish);
    const R = p.diameter / 2;
    const shankD =
      p.shank === 'hex'
        ? HEX_QUARTER
        : p.shank === 'reduced'
          ? 2 * reducedShankRadius(R)
          : p.diameter;
    return {
      parts: [
        { name: 'shank', role: 'shank', material: mats.shank, mesh: m.shank, crease: 35 },
        { name: 'body', role: 'tip', material: mats.body, mesh: m.body, crease: 55 },
      ],
      hang: { point: [0, 0, 0], kind: 'butt' },
      zones: [
        { name: 'shank', y0: 0, y1: m.shankLength },
        { name: 'flutes', y0: m.shankLength, y1: total },
      ],
      dims: {
        length: total,
        diameter: p.diameter,
        shaftDiameter: Math.max(shankD, p.diameter),
        shankDiameter: shankD,
        fluteLength: flute,
        pointAngle: p.pointAngle,
      },
    };
  },
});
