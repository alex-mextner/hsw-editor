/**
 * Nut driver (socket screwdriver): colour-coded fluted handle, chrome collar, hollow tube shaft that ends
 * in a flared head with a real hex bore (visible lead-in chamfer). Sizes 5.5..13 mm across flats; the tube
 * wall follows the bore (outer radius = hex circumradius + 1.25 mm, e.g. 8 mm AF -> 11.5 mm OD) and the
 * overall length is about 190..260 mm like Wera / Hazet / Stanley nut drivers (handle 90-105 mm).
 */
import { type V2, lerp, smoothstep } from '../../math.ts';
import { METALS, type Material, plastic, rubber } from '../../materials.ts';
import type { BuiltTool, Part } from '../../model.ts';
import { L, choice, color, num } from '../../params.ts';
import { type BuildCtx, defineToolClass } from '../../registry.ts';
import { type Station, lathe, loft } from '../../build/primitives.ts';
import { profileStations, sampleProfile } from '../../build/profile.ts';
import { circleRing, flutedRing, lobedRing } from '../../build/rings.ts';
import { hexCircumRadius, hexRing } from './shared.ts';

const HANDLES = ['fluted', 'soft-grip', 'tri-lobe'] as const;
const FINISHES = ['chrome', 'black-oxide', 'zinc'] as const;

const schema = {
  size: num(L('Socket size (across flats)', 'Размер головки'), 8, 5.5, 13, { step: 0.5 }),
  shaftLength: num(L('Shaft length', 'Длина стержня'), 100, 60, 200, { step: 5 }),
  handleLength: num(L('Handle length', 'Длина рукоятки'), 95, 70, 120, { step: 1 }),
  handleDiameter: num(L('Handle diameter', 'Диаметр рукоятки'), 31, 22, 40, { step: 0.5 }),
  handle: choice(L('Handle style', 'Форма рукоятки'), HANDLES, 'fluted'),
  shaftFinish: choice(L('Shaft finish', 'Покрытие стержня'), FINISHES, 'chrome'),
  handleColor: color(L('Handle colour', 'Цвет рукоятки'), '#e8741e'),
  gripColor: color(L('Grip colour', 'Цвет накладки'), '#1b1c1e'),
};

/** Control profiles [t along the handle, radius factor] (butt at t = 0). */
const PROFILES: Record<(typeof HANDLES)[number], readonly V2[]> = {
  fluted: [
    [0, 0],
    [0.012, 0.62],
    [0.04, 0.9],
    [0.1, 0.99],
    [0.3, 1],
    [0.6, 0.93],
    [0.84, 0.8],
    [0.95, 0.72],
    [1, 0.7],
  ],
  'soft-grip': [
    [0, 0],
    [0.015, 0.62],
    [0.05, 0.9],
    [0.14, 1],
    [0.45, 0.94],
    [0.62, 0.9],
    [0.82, 0.93],
    [0.94, 0.78],
    [1, 0.68],
  ],
  'tri-lobe': [
    [0, 0],
    [0.015, 0.6],
    [0.06, 0.9],
    [0.2, 1],
    [0.55, 0.96],
    [0.8, 0.86],
    [0.95, 0.74],
    [1, 0.7],
  ],
};

/** Sub-profile of `control` between a and b, re-based to t in 0..1. */
function subProfile(control: readonly V2[], a: number, b: number): V2[] {
  const rebase = (t: number): number => (t - a) / (b - a);
  return [
    [0, sampleProfile(control, a)],
    ...control.filter(([t]) => t > a && t < b).map(([t, f]): V2 => [rebase(t), f]),
    [1, sampleProfile(control, b)],
  ];
}

function shaftMaterial(f: (typeof FINISHES)[number]): Material {
  return f === 'chrome' ? METALS.chrome : f === 'zinc' ? METALS.zinc : METALS.blackOxide;
}

function buildHandle(
  style: (typeof HANDLES)[number],
  Lh: number,
  R: number,
  handleColor: string,
  gripColor: string,
  ctx: BuildCtx,
): { parts: Part[]; neckR: number } {
  const N = ctx.seg(96, 36);
  const control = PROFILES[style];
  const hardMat = plastic(handleColor, 0.34, 'handle plastic');
  const parts: Part[] = [];
  const neckR = R * ((control[control.length - 1] as V2)[1] as number);
  const fade = (t: number, a: number, b: number): number =>
    smoothstep(a, a + 0.1, t) * (1 - smoothstep(b - 0.1, b, t));
  if (style === 'fluted') {
    const stations = profileStations(control, 0, Lh, (f, t) =>
      flutedRing(R * f, 10, 0.075 * R * fade(t, 0.04, 0.93), N),
    );
    parts.push({
      name: 'handle',
      role: 'handle',
      material: hardMat,
      mesh: loft(stations),
      crease: 60,
    });
  } else if (style === 'soft-grip') {
    const core = profileStations(control, 0, Lh, (f) => circleRing(R * f * 0.92, N));
    parts.push({ name: 'handle', role: 'handle', material: hardMat, mesh: loft(core), crease: 60 });
    const a = 0.09;
    const b = 0.9;
    const gc = subProfile(control, a, b);
    const grip = profileStations(gc, Lh * a, Lh * b, (f, t) =>
      flutedRing(R * f, 8, 0.05 * R * smoothstep(0, 0.2, t) * (1 - smoothstep(0.8, 1, t)), N),
    );
    parts.push({
      name: 'grip',
      role: 'grip',
      material: rubber(gripColor, 'ribbed', 'grip rubber'),
      mesh: loft(grip),
      crease: 55,
    });
  } else {
    const a = 0.08;
    const b = 0.92;
    const gc = subProfile(control, a, b);
    const soft = profileStations(gc, Lh * a, Lh * b, (f, t) => {
      const amp = 0.09 * R * f * smoothstep(0, 0.2, t) * (1 - smoothstep(0.8, 1, t));
      return lobedRing(R * f, amp, 3, N);
    });
    const core = profileStations(control, 0, Lh, (f) => circleRing(R * f * 0.82, N));
    parts.push({ name: 'handle', role: 'handle', material: hardMat, mesh: loft(core), crease: 60 });
    parts.push({
      name: 'grip',
      role: 'grip',
      material: rubber(gripColor, 'soft-grip', 'grip rubber'),
      mesh: loft(soft),
      crease: 55,
    });
  }
  return { parts, neckR };
}

export const nutDriver = defineToolClass({
  id: 'nut-driver',
  family: 'drivers',
  name: L('Nut driver', 'Торцевая отвёртка'),
  bankClass: 'screwdriver',
  keywords: {
    en: ['nut driver', 'socket screwdriver', 'hex nut driver', 'nut spinner'],
    ru: ['торцевая отвертка', 'торцевая отвёртка', 'ключ-отвертка', 'головка с рукояткой'],
  },
  schema,
  presets: [
    { id: 'nd-8-orange', label: L('8 mm, orange fluted', '8 мм, оранжевая'), values: {} },
    {
      id: 'nd-5p5-red',
      label: L('5.5 mm, red', '5,5 мм, красная'),
      values: {
        size: 5.5,
        shaftLength: 75,
        handleLength: 82,
        handleDiameter: 27,
        handleColor: '#c8262b',
      },
    },
    {
      id: 'nd-10-blue-grip',
      label: L('10 mm, blue soft grip', '10 мм, синяя с накладкой'),
      values: {
        size: 10,
        handle: 'soft-grip',
        shaftLength: 110,
        handleLength: 100,
        handleDiameter: 33,
        handleColor: '#2455a8',
      },
    },
    {
      id: 'nd-7-yellow',
      label: L('7 mm, yellow tri-lobe', '7 мм, жёлтая трёхгранная'),
      values: {
        size: 7,
        handle: 'tri-lobe',
        shaftLength: 90,
        handleColor: '#f0c326',
        gripColor: '#2b2d31',
        shaftFinish: 'black-oxide',
      },
    },
    {
      id: 'nd-13-green',
      label: L('13 mm, green long', '13 мм, зелёная длинная'),
      values: {
        size: 13,
        shaftLength: 160,
        handleLength: 110,
        handleDiameter: 37,
        handleColor: '#2f8f4c',
        shaftFinish: 'zinc',
      },
    },
  ],
  build(p, ctx): BuiltTool {
    const R = p.handleDiameter / 2;
    const Lh = p.handleLength;
    const hexR = hexCircumRadius(p.size);
    const tubeR = hexR + 1.25;
    const headR = tubeR + 0.9;
    const handle = buildHandle(p.handle, Lh, R, p.handleColor, p.gripColor, ctx);
    const parts: Part[] = [...handle.parts];
    const yEnd = Lh + p.shaftLength;
    const N = ctx.seg(48, 24);

    // collar between handle and tube
    const collarR = Math.max(tubeR * 1.12, Math.min(handle.neckR * 0.98, R * 0.62));
    parts.push({
      name: 'ferrule',
      role: 'ferrule',
      material: METALS.chrome,
      mesh: lathe(
        [
          [collarR * 0.98, Lh - 9],
          [collarR * 1.03, Lh - 7],
          [collarR * 1.03, Lh + 1.5],
          [collarR * 0.86, Lh + 4.5],
          [tubeR * 1.2, Lh + 9],
          [tubeR * 1.05, Lh + 12],
        ],
        ctx.seg(40, 20),
      ),
    });

    // hollow tube: pole - outer wall - flared head - rim - hex bore - bore floor
    const depth = Math.min(p.shaftLength * 0.7, 14 + p.size * 1.4);
    const yStart = Lh * 0.6;
    const yFlare = yEnd - depth - 4;
    const hex = hexRing(p.size, N);
    const hexLead = hexRing(p.size * 1.12, N);
    const flat = (r: number): V2[] => circleRing(r, N);
    const pole: V2[] = new Array<V2>(N).fill([0, 0]);
    const stations: Station[] = [
      { y: yStart, ring: pole },
      { y: yStart, ring: flat(tubeR) },
      { y: yFlare, ring: flat(tubeR) },
      { y: yFlare + 2.5, ring: flat(lerp(tubeR, headR, 0.6)) },
      { y: yFlare + 5, ring: flat(headR) },
      { y: yEnd - 0.7, ring: flat(headR) },
      { y: yEnd, ring: flat(headR - 0.7) },
      { y: yEnd, ring: hexLead },
      { y: yEnd - 0.9, ring: hex },
      { y: yEnd - depth, ring: hex },
      { y: yEnd - depth, ring: pole },
    ];
    parts.push({
      name: 'shaft',
      role: 'shaft',
      material: shaftMaterial(p.shaftFinish),
      mesh: loft(stations, { caps: 'none' }),
      crease: 40,
    });

    return {
      parts,
      hang: { point: [0, Lh, 0], kind: 'neck' },
      zones: [
        { name: 'handle', y0: 0, y1: Lh },
        { name: 'shaft', y0: Lh, y1: yEnd - depth },
        { name: 'socket', y0: yEnd - depth, y1: yEnd },
      ],
      dims: {
        length: yEnd,
        handleLength: Lh,
        handleDiameter: p.handleDiameter,
        shaftLength: p.shaftLength,
        shaftDiameter: 2 * tubeR,
        headDiameter: 2 * headR,
        socketSize: p.size,
        socketDepth: depth,
        collarDiameter: collarR * 2.06,
      },
    };
  },
});
